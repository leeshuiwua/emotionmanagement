import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import type { SqliteDb } from "../src/server/db.js";
import { activePollerCount, stopAll } from "../src/server/im/index.js";
import { handleInbound } from "../src/server/im/router.js";
import { getChannel } from "../src/server/im/store.js";

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
	while (handles.length) {
		const h = handles.pop();
		if (h) await h.app.close();
	}
	stopAll();
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
	it("filters stored chats and returns an evidence-labelled contact profile", async () => {
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
		expect(records.body.items[0]).toHaveProperty("emotionScore");

		const profiles = await request(app.app)
			.get(`/admin-api/v1/im/profiles?channelId=${channel.id}`)
			.set("Cookie", cookie);
		expect(profiles.status).toBe(200);
		expect(profiles.body.profiles).toHaveLength(1);
		expect(profiles.body.profiles[0].messageCount).toBe(2);
		expect(profiles.body.profiles[0].mbti).toMatch(/^[EISNTFJPX]{4}$/);
		expect(profiles.body.profiles[0].confidence).toBe("low");
		expect(profiles.body.profiles[0].emotion.trend).toHaveLength(1);
	});

	it("keeps conversation records behind admin authentication", async () => {
		const { app } = await boot();
		const res = await request(app.app).get("/admin-api/v1/im/conversations");
		expect(res.status).toBe(401);
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
