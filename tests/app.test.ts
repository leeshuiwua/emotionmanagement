import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import * as intentModule from "../src/server/core/intent.js";
import type { SqliteDb } from "../src/server/db.js";
import { activeSetting } from "../src/server/http/settings.js";
import { activePollerCount, stopAll } from "../src/server/im/index.js";
import { handleInbound } from "../src/server/im/router.js";
import { getChannel } from "../src/server/im/store.js";
import { personFor, recordEvent } from "../src/server/memory/store.js";

const config: AppConfig = {
	env: "test",
	host: "127.0.0.1",
	port: 3102,
	databasePath: ":memory:",
	publicBaseUrl: "http://localhost:3002",
	masterKey: randomBytes(32),
	cookieSecure: false,
	bootstrapAdminUsername: "admin",
	bootstrapAdminPassword: "correct-horse-battery-staple",
};

type AppHandle = {
	app: Awaited<ReturnType<typeof createApp>>;
	db: SqliteDb;
	cookie: string;
	csrf: string;
};

const handles: AppHandle[] = [];

async function boot(): Promise<AppHandle> {
	const app = await createApp(config);
	const login = await request(app.app)
		.post("/admin-api/v1/auth/login")
		.send({
			username: "admin",
			password: config.bootstrapAdminPassword as string,
		});
	expect(login.status).toBe(200);
	const setCookie = login.headers["set-cookie"];
	const cookie = String(setCookie?.[0] ?? "").split(";")[0];
	const csrf = login.body.csrfToken as string;
	const handle = { app, db: app.db, cookie, csrf };
	handles.push(handle);
	return handle;
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (handles.length) {
		const h = handles.pop();
		if (h) await h.app.close();
	}
	stopAll();
});

describe("memory administration", () => {
	it("requires authentication, CSRF and explicit deletion confirmation; isolates corrections and deletion", async () => {
		const { app, db, cookie, csrf } = await boot();
		const a = personFor(db, "channel", "a"),
			b = personFor(db, "channel", "b");
		recordEvent(db, a, "1", "今天开心", "已记录心情", "insight");
		recordEvent(db, b, "1", "今天平静", "已记录心情", "insight");
		db.prepare(
			"INSERT INTO memory_facts(id,person_id,kind,text,evidence_json,created_at) VALUES('fact',?,'pattern','需要纠正','[]',?)",
		).run(a.id, new Date().toISOString());
		const endpoint = `/admin-api/v1/memory/${a.id}`;
		expect((await request(app.app).get(endpoint)).status).toBe(401);
		expect(
			(await request(app.app).post(`${endpoint}/refresh`).set("Cookie", cookie))
				.status,
		).toBe(403);
		expect(
			(
				await request(app.app)
					.delete(endpoint)
					.set("Cookie", cookie)
					.set("x-csrf-token", csrf)
					.send({})
			).status,
		).toBe(400);
		const wrong = await request(app.app)
			.post(`/admin-api/v1/memory/${b.id}/facts/fact/correct`)
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send({ correction: "不准确" });
		expect(wrong.status).toBe(404);
		const correction = await request(app.app)
			.post(`${endpoint}/facts/fact/correct`)
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send({ correction: "这是一次性的状态" });
		expect(correction.status).toBe(200);
		const view = await request(app.app).get(endpoint).set("Cookie", cookie);
		expect(view.body.facts[0].invalidatedAt).toBeTruthy();
		expect(view.body.facts[0].correction).toBe("这是一次性的状态");
		expect(view.body.task.status).toBe("pending");
		const cleared = await request(app.app)
			.delete(endpoint)
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send({ confirmation: "CLEAR_PERSON_MEMORY" });
		expect(cleared.status).toBe(200);
		const users = await request(app.app)
			.get("/admin-api/v1/memory/users")
			.set("Cookie", cookie);
		expect(
			users.body.users.map((p: { personId: string }) => p.personId),
		).toEqual([b.id]);
		expect(
			db
				.prepare("SELECT count(*) AS n FROM memory_facts WHERE person_id=?")
				.get(a.id),
		).toEqual({ n: 0 });
	});
});

describe("health and auth", () => {
	it("sets Secure cookies only when auto mode sees an HTTPS request", async () => {
		const autoConfig: AppConfig = { ...config, cookieSecure: "auto" };
		const app = await createApp(autoConfig);
		handles.push({ app, db: app.db, cookie: "", csrf: "" });

		const httpLogin = await request(app.app)
			.post("/admin-api/v1/auth/login")
			.send({
				username: "admin",
				password: config.bootstrapAdminPassword as string,
			});
		expect(String(httpLogin.headers["set-cookie"]?.[0])).not.toContain(
			"Secure",
		);

		const httpsLogin = await request(app.app)
			.post("/admin-api/v1/auth/login")
			.set("x-forwarded-proto", "https")
			.send({
				username: "admin",
				password: config.bootstrapAdminPassword as string,
			});
		expect(String(httpsLogin.headers["set-cookie"]?.[0])).toContain("Secure");
	});

	it("treats the legacy true setting as protocol-aware for existing deployments", async () => {
		const app = await createApp({ ...config, cookieSecure: true });
		handles.push({ app, db: app.db, cookie: "", csrf: "" });
		const login = await request(app.app)
			.post("/admin-api/v1/auth/login")
			.send({
				username: "admin",
				password: config.bootstrapAdminPassword as string,
			});
		expect(String(login.headers["set-cookie"]?.[0])).not.toContain("Secure");
	});

	it("supports explicitly forcing Secure cookies", async () => {
		const app = await createApp({ ...config, cookieSecure: "force" });
		handles.push({ app, db: app.db, cookie: "", csrf: "" });
		const login = await request(app.app)
			.post("/admin-api/v1/auth/login")
			.send({
				username: "admin",
				password: config.bootstrapAdminPassword as string,
			});
		expect(String(login.headers["set-cookie"]?.[0])).toContain("Secure");
	});

	it("serves /healthz without auth", async () => {
		const { app } = await boot();
		const res = await request(app.app).get("/healthz");
		expect(res.status).toBe(200);
		expect(res.body.status).toBe("ok");
	});

	it("rejects unauthenticated system status", async () => {
		const { app } = await boot();
		const res = await request(app.app).get("/admin-api/v1/system/status");
		expect(res.status).toBe(401);
	});

	it("requires CSRF token on mutations", async () => {
		const { app, cookie } = await boot();
		const res = await request(app.app)
			.post("/admin-api/v1/settings/models/regular")
			.set("Cookie", cookie)
			.send({ config: { baseUrl: "https://example.com/v1", model: "test" } });
		expect(res.status).toBe(403);
	});

	it("logs out and clears the session", async () => {
		const { app, cookie, csrf } = await boot();
		const res = await request(app.app)
			.post("/admin-api/v1/auth/logout")
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf);
		expect(res.status).toBe(204);
		const after = await request(app.app)
			.get("/admin-api/v1/auth/session")
			.set("Cookie", cookie);
		expect(after.status).toBe(401);
	});
});

describe("model settings lifecycle", () => {
	it.each(["regular", "safety"])(
		"keeps replacement drafts visible and activates them for %s",
		async (role) => {
			const { app, db, cookie, csrf } = await boot();
			const path = `/admin-api/v1/settings/models/${role}`;
			const post = (suffix = "", body = {}) =>
				request(app.app)
					.post(path + suffix)
					.set("Cookie", cookie)
					.set("x-csrf-token", csrf)
					.send(body);
			const read = () => request(app.app).get(path).set("Cookie", cookie);
			const first = await post("", {
				config: { baseUrl: "https://example.com/v1", model: "old" },
				secret: "old-key",
			});
			expect((await post("/test")).status).toBe(200);
			expect((await post("/activate")).status).toBe(200);
			const replacement = await post("", {
				config: { baseUrl: "https://example.com/v1", model: "new" },
				secret: "replacement-key",
			});
			expect(replacement.status).toBe(201);
			expect(replacement.body.status).toBe("DRAFT");
			expect(replacement.body.id).not.toBe(first.body.id);
			expect((await read()).body.id).toBe(replacement.body.id);
			expect(activeSetting(db, config, "model", role)?.config.model).toBe(
				"old",
			);
			// Equal timestamps still select the last inserted draft; blank keys inherit it.
			db.prepare("UPDATE setting_versions SET created_at = ?").run(
				"2026-01-01T00:00:00.000Z",
			);
			vi.spyOn(Date.prototype, "toISOString").mockReturnValue(
				"2026-01-01T00:00:00.000Z",
			);
			const revised = await post("", {
				config: { baseUrl: "https://example.com/v1", model: "new-final" },
			});
			expect(revised.body.id).not.toBe(replacement.body.id);
			expect((await read()).body.id).toBe(revised.body.id);
			expect((await post("/activate")).status).toBe(409);
			expect((await post("/test")).status).toBe(200);
			expect((await read()).body.status).toBe("TESTED");
			expect((await post("/activate")).body.id).toBe(revised.body.id);
			expect((await read()).body.status).toBe("ACTIVE");
			expect(activeSetting(db, config, "model", role)).toMatchObject({
				config: { model: "new-final" },
				secret: "replacement-key",
			});
			expect(
				db
					.prepare(
						"SELECT count(*) AS count FROM setting_versions WHERE role = ? AND status = 'ACTIVE'",
					)
					.get(role),
			).toEqual({ count: 1 });
			expect(JSON.stringify((await read()).body)).not.toContain(
				"replacement-key",
			);
		},
	);
	it("enforces DRAFT → TESTED → ACTIVE and never returns the raw key", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };

		// Cannot activate before testing
		const early = await request(app.app)
			.post("/admin-api/v1/settings/models/regular/activate")
			.set("Cookie", cookie)
			.set(headers);
		expect(early.status).toBe(409);

		// Save draft
		const draft = await request(app.app)
			.post("/admin-api/v1/settings/models/regular")
			.set("Cookie", cookie)
			.set(headers)
			.send({
				config: { baseUrl: "https://example.com/v1", model: "test-model" },
				secret: "sk-secret-123456",
			});
		expect(draft.status).toBe(201);
		expect(JSON.stringify(draft.body)).not.toContain("sk-secret-123456");

		// Test
		const tested = await request(app.app)
			.post("/admin-api/v1/settings/models/regular/test")
			.set("Cookie", cookie)
			.set(headers);
		expect(tested.status).toBe(200);

		// Activate
		const active = await request(app.app)
			.post("/admin-api/v1/settings/models/regular/activate")
			.set("Cookie", cookie)
			.set(headers);
		expect(active.status).toBe(200);
		expect(active.body.status).toBe("ACTIVE");
	});

	it("saves a safety model independently", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };
		const draft = await request(app.app)
			.post("/admin-api/v1/settings/models/safety")
			.set("Cookie", cookie)
			.set(headers)
			.send({
				config: { baseUrl: "https://example.com/v1", model: "safety-model" },
				secret: "sk-safety-key",
			});
		expect(draft.status).toBe(201);
		expect(draft.body.role).toBe("safety");
	});
});

describe("IM channel CRUD", () => {
	it("creates, lists, updates and deletes a wechat channel", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };

		// Create
		const created = await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set(headers)
			.send({ type: "wechat", name: "我的微信" });
		expect(created.status).toBe(201);
		expect(created.body.channel.type).toBe("wechat");
		expect(created.body.channel.enabled).toBe(false);
		const channelId = created.body.channel.id as string;

		// List
		const list = await request(app.app)
			.get("/admin-api/v1/im/channels")
			.set("Cookie", cookie);
		expect(list.status).toBe(200);
		expect(list.body.channels).toHaveLength(1);

		// Update name
		const updated = await request(app.app)
			.put(`/admin-api/v1/im/channels/${channelId}`)
			.set("Cookie", cookie)
			.set(headers)
			.send({ name: "专用微信" });
		expect(updated.status).toBe(200);
		expect(updated.body.channel.name).toBe("专用微信");

		// Delete
		const deleted = await request(app.app)
			.delete(`/admin-api/v1/im/channels/${channelId}`)
			.set("Cookie", cookie)
			.set(headers);
		expect(deleted.status).toBe(200);
		expect(deleted.body.ok).toBe(true);

		const after = await request(app.app)
			.get("/admin-api/v1/im/channels")
			.set("Cookie", cookie);
		expect(after.body.channels).toHaveLength(0);
	});

	it("rejects enabling a channel without a token", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };
		const created = await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set(headers)
			.send({ type: "wechat", name: "空渠道" });
		const id = created.body.channel.id as string;
		const enable = await request(app.app)
			.put(`/admin-api/v1/im/channels/${id}`)
			.set("Cookie", cookie)
			.set(headers)
			.send({ enabled: true });
		expect(enable.status).toBe(400);
	});

	it("rejects invalid channel type", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };
		const res = await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set(headers)
			.send({ type: "telegram", name: "tg" });
		expect(res.status).toBe(400);
	});

	it("does not start a poller for token-less channels", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };
		await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set(headers)
			.send({ type: "wechat", name: "无凭据" });
		expect(activePollerCount()).toBe(0);
	});
});

describe("conversation archive and psychological profiles", () => {
	it("clears all mood records with confirmation while preserving channels and replay protection", async () => {
		const { app, db, cookie, csrf } = await boot();
		const path = "/admin-api/v1/im/mood-records";
		expect((await request(app.app).delete(path)).status).toBe(401);
		expect(
			(await request(app.app).delete(path).set("Cookie", cookie)).status,
		).toBe(403);
		const clear = (body: object) =>
			request(app.app)
				.delete(path)
				.set("Cookie", cookie)
				.set("x-csrf-token", csrf)
				.send(body);
		expect((await clear({})).status).toBe(400);
		const created = await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send({ type: "wechat" });
		const channel = getChannel(db, created.body.channel.id);
		if (!channel) throw new Error("channel");
		vi.spyOn(intentModule, "recognizeIntent").mockResolvedValue({
			intent: "both",
			entries: [
				{
					kind: "expense",
					amount: "35",
					date: "2026-01-01",
					category: "餐饮",
					account: "现金",
					note: "午饭",
				},
			],
		});
		await handleInbound(db, config, channel, "a", "花35心疼", {
			messageId: "clear1",
		});
		await handleInbound(db, config, channel, "b", "花35心疼", {
			messageId: "clear2",
		});
		db.prepare(
			"INSERT INTO mood_analyses VALUES ('test', '{}', '2026-01-01')",
		).run();
		const result = await clear({ confirmation: "CLEAR_ALL_MOOD_RECORDS" });
		expect(result.status).toBe(200);
		expect(result.body.deleted).toBe(2);
		expect(db.prepare("SELECT count(*) AS n FROM conversations").get()).toEqual(
			{ n: 0 },
		);
		expect(db.prepare("SELECT count(*) AS n FROM mood_analyses").get()).toEqual(
			{ n: 0 },
		);
		expect(
			db.prepare("SELECT count(*) AS n FROM ledger_entries").get(),
		).toEqual({ n: 2 });
		expect(
			db
				.prepare(
					"SELECT count(*) AS n FROM inbound_messages WHERE content IS NOT NULL OR raw_xml <> '{}'",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(getChannel(db, channel.id)).toBeTruthy();
		expect(
			await handleInbound(db, config, channel, "a", "花35心疼", {
				messageId: "clear1",
			}),
		).toBe("");
		expect(
			(await clear({ confirmation: "CLEAR_ALL_MOOD_RECORDS" })).body.deleted,
		).toBe(0);
	});
	it("protects model analysis and validates Beijing date ranges", async () => {
		const { app, cookie, csrf } = await boot();
		const endpoint = "/admin-api/v1/im/mood-analysis?channelId=c&contactId=a";
		expect((await request(app.app).post(endpoint)).status).toBe(401);
		expect(
			(await request(app.app).post(endpoint).set("Cookie", cookie)).status,
		).toBe(403);
		expect(
			(
				await request(app.app)
					.post(endpoint)
					.set("Cookie", cookie)
					.set("x-csrf-token", csrf)
			).status,
		).toBe(404);
		expect(
			(
				await request(app.app)
					.post("/admin-api/v1/im/mood-analysis")
					.set("Cookie", cookie)
					.set("x-csrf-token", csrf)
			).status,
		).toBe(400);
		for (const range of ["from=2026-02-30", "from=2026-09-02&to=2026-09-01"])
			expect(
				(
					await request(app.app)
						.get(`/admin-api/v1/im/conversations?${range}`)
						.set("Cookie", cookie)
				).status,
			).toBe(400);
	});
	it("uses Beijing midnight boundaries instead of UTC midnight", async () => {
		vi.spyOn(intentModule, "recognizeIntent").mockResolvedValue({
			intent: "insight",
		});
		const { app, db, cookie, csrf } = await boot();
		const created = await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send({ type: "wechat" });
		const channel = getChannel(db, created.body.channel.id);
		if (!channel) throw new Error("channel");
		await handleInbound(db, config, channel, "a", "今天开心", {
			messageId: "date",
		});
		db.prepare(
			"UPDATE conversations SET created_at='2026-09-01T16:00:00.000Z'",
		).run();
		const first = await request(app.app)
			.get("/admin-api/v1/im/conversations?from=2026-09-01&to=2026-09-01")
			.set("Cookie", cookie);
		const second = await request(app.app)
			.get("/admin-api/v1/im/conversations?from=2026-09-02&to=2026-09-02")
			.set("Cookie", cookie);
		expect(first.body.total).toBe(0);
		expect(second.body.total).toBe(1);
	});
	it("filters stored chats and returns an evidence-labelled contact profile", async () => {
		// 本用例验证已识别的心境消息归档；不可用分类不应生成心理记录。
		vi.spyOn(intentModule, "recognizeIntent").mockResolvedValue({
			intent: "insight",
		});
		const { app, db, cookie, csrf } = await boot();
		const created = await request(app.app)
			.post("/admin-api/v1/im/channels")
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send({ type: "wechat", name: "倾听号" });
		const channel = getChannel(db, created.body.channel.id as string);
		expect(channel).not.toBeNull();
		if (!channel) throw new Error("channel missing");
		await handleInbound(
			db,
			config,
			channel,
			"wx-contact-a",
			"今天压力很大，我有点焦虑和担心，不知道怎么办。",
			{ messageId: "m-1" },
		);
		await handleInbound(
			db,
			config,
			channel,
			"wx-contact-a",
			"我想先分析原因，然后安排明天的计划。",
			{ messageId: "m-2", messageType: "voice" },
		);

		const records = await request(app.app)
			.get(
				`/admin-api/v1/im/conversations?channelId=${channel.id}&contactId=wx-contact-a&pageSize=1`,
			)
			.set("Cookie", cookie);
		expect(records.status).toBe(200);
		expect(records.body.total).toBe(2);
		expect(records.body.items).toHaveLength(1);
		expect(records.body.items[0].contactLabel).toBe("wx-co…ct-a");
		expect(records.body.items[0].messageType).toBe("voice");
		expect(records.body.items[0]).not.toHaveProperty("emotionScore");

		const profiles = await request(app.app)
			.get(`/admin-api/v1/im/profiles?channelId=${channel.id}`)
			.set("Cookie", cookie);
		expect(profiles.status).toBe(200);
		expect(profiles.body.profiles).toHaveLength(1);
		expect(profiles.body.profiles[0].messageCount).toBe(2);
		expect(profiles.body.profiles[0]).not.toHaveProperty("mbti");
	});

	it("keeps conversation records behind admin authentication", async () => {
		const { app } = await boot();
		const res = await request(app.app).get("/admin-api/v1/im/conversations");
		expect(res.status).toBe(401);
	});
});

describe("ledger API", () => {
	it("protects writes, validates inputs and updates totals after soft deletion", async () => {
		const { app, cookie, csrf } = await boot();
		expect(
			(await request(app.app).get("/admin-api/v1/ledger/books")).status,
		).toBe(401);
		const books = await request(app.app)
			.get("/admin-api/v1/ledger/books")
			.set("Cookie", cookie);
		const url = `/admin-api/v1/ledger/books/${books.body.books[0].id}/entries`;
		const entry = {
			kind: "expense",
			amount: "35.29",
			category: "餐饮",
			account: "现金",
			date: "2026-09-05",
			note: "午饭",
		};
		expect(
			(await request(app.app).post(url).set("Cookie", cookie).send(entry))
				.status,
		).toBe(403);
		expect(
			(
				await request(app.app)
					.post(url)
					.set("Cookie", cookie)
					.set("x-csrf-token", csrf)
					.send({ ...entry, amount: "-1" })
			).status,
		).toBe(400);
		const created = await request(app.app)
			.post(url)
			.set("Cookie", cookie)
			.set("x-csrf-token", csrf)
			.send(entry);
		expect(created.status).toBe(201);
		const listed = await request(app.app)
			.get(`${url}?month=2026-09`)
			.set("Cookie", cookie);
		expect(listed.body.summary.expense).toBe(3529);
		expect(listed.body.total).toBe(1);
		expect(
			(await request(app.app).get(`${url}?month=2026-13`).set("Cookie", cookie))
				.status,
		).toBe(400);
		expect(
			(
				await request(app.app)
					.delete(`${url}/${created.body.id}`)
					.set("Cookie", cookie)
					.set("x-csrf-token", csrf)
			).status,
		).toBe(204);
		const after = await request(app.app)
			.get(`${url}?month=2026-09`)
			.set("Cookie", cookie);
		expect(after.body.summary.expense).toBe(0);
		expect(after.body.total).toBe(0);
	});
});

describe("system status and audit", () => {
	it("returns metrics and settings summary", async () => {
		const { app, cookie, csrf } = await boot();
		const headers = { "x-csrf-token": csrf };
		// Save + test + activate a model so status shows up
		await request(app.app)
			.post("/admin-api/v1/settings/models/regular")
			.set("Cookie", cookie)
			.set(headers)
			.send({
				config: { baseUrl: "https://example.com/v1", model: "m" },
				secret: "sk-x",
			});
		await request(app.app)
			.post("/admin-api/v1/settings/models/regular/test")
			.set("Cookie", cookie)
			.set(headers);
		await request(app.app)
			.post("/admin-api/v1/settings/models/regular/activate")
			.set("Cookie", cookie)
			.set(headers);

		const status = await request(app.app)
			.get("/admin-api/v1/system/status")
			.set("Cookie", cookie);
		expect(status.status).toBe(200);
		expect(status.body.service).toBe("healthy");
		expect(status.body.metrics.users).toBe(0);
		expect(
			status.body.settings.some(
				(s: { kind: string; status: string }) =>
					s.kind === "model" && s.status === "ACTIVE",
			),
		).toBe(true);
	});

	it("lists audit events", async () => {
		const { app, cookie } = await boot();
		// login itself creates an audit event
		const events = await request(app.app)
			.get("/admin-api/v1/audit-events?limit=10")
			.set("Cookie", cookie);
		expect(events.status).toBe(200);
		expect(Array.isArray(events.body)).toBe(true);
		expect(events.body.length).toBeGreaterThan(0);
	});
});
