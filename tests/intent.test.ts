import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { createCoachReply } from "../src/server/core/coach.js";
import { recognizeIntent } from "../src/server/core/intent.js";
import { openDatabase } from "../src/server/db.js";
import { handleInbound } from "../src/server/im/router.js";
import { createChannel } from "../src/server/im/store.js";
import { chinaDate } from "../src/server/ledger.js";

vi.mock("../src/server/http/settings.js", () => ({
	activeSetting: () => ({
		secret: "test-key",
		config: { baseUrl: "https://model.example/v1", model: "deepseek-v4-flash" },
	}),
}));
vi.mock("../src/server/core/coach.js", () => ({
	createCoachReply: vi.fn(async () => ({
		level: "NONE",
		text: "听起来这件事让你很难受。",
		source: "model",
	})),
}));
const config = {} as AppConfig;
const databases: ReturnType<typeof openDatabase>[] = [];
const boot = () => {
	const db = openDatabase(":memory:");
	databases.push(db);
	return db;
};
const entry = {
	kind: "expense",
	amount: "35.00",
	category: "餐饮",
	account: "微信",
	date: chinaDate(),
	note: "午饭",
};
function mockResult(result: unknown) {
	const fn = vi.fn().mockResolvedValue({
		ok: true,
		json: async () => ({
			choices: [{ message: { content: JSON.stringify(result) } }],
		}),
	});
	vi.stubGlobal("fetch", fn);
	return fn;
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	for (const db of databases.splice(0)) db.close();
});

describe("automatic message routing", () => {
	it("stores mixed needs atomically and deduplicates concurrent deliveries", async () => {
		const db = boot(),
			channel = createChannel(db, { type: "wechat" });
		mockResult({
			intent: "both",
			entries: [entry, { ...entry, amount: "20", category: "交通" }],
		});
		const send = () =>
			handleInbound(
				db,
				config,
				channel,
				"alice",
				"午饭35，打车20，今天很开心",
				{ messageId: "mixed" },
			);
		const replies = await Promise.all([send(), send()]);
		expect(replies.filter(Boolean)).toHaveLength(1);
		expect(replies.join("")).toContain("已记录你的心情");
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n,SUM(cents) AS cents FROM ledger_entries WHERE status='posted'",
				)
				.get(),
		).toEqual({ n: 2, cents: 5500 });
		expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual(
			{ n: 1 },
		);
		expect(createCoachReply).not.toHaveBeenCalled();
	});
	it("rolls back financial writes when the mixed mood write fails", async () => {
		const db = boot(),
			channel = createChannel(db, { type: "wechat" });
		mockResult({ intent: "both", entries: [entry] });
		db.exec(
			"CREATE TRIGGER reject_mood BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'test failure'); END;",
		);
		await expect(
			handleInbound(db, config, channel, "alice", "花35元，很开心", {
				messageId: "rollback",
			}),
		).rejects.toThrow();
		for (const table of [
			"ledger_entries",
			"ledger_receipts",
			"inbound_messages",
			"wechat_users",
		])
			expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
				n: 0,
			});
	});
	it("does not create personal records for unsupported requests", async () => {
		const db = boot(),
			channel = createChannel(db, { type: "wechat" });
		mockResult({ intent: "unsupported" });
		expect(
			await handleInbound(db, config, channel, "alice", "帮我写代码", {
				messageId: "outside",
			}),
		).toContain("仅支持生活记账");
		expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual(
			{ n: 0 },
		);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get(),
		).toEqual({ n: 0 });
	});
	it("uses non-thinking JSON mode for the 194 yuan dinner regression", async () => {
		const db = boot();
		const channel = createChannel(db, { type: "wechat" });
		const fetchMock = mockResult({
			intent: "ledger",
			entry: { ...entry, amount: 194 },
		});
		const reply = await handleInbound(
			db,
			config,
			channel,
			"alice",
			"今天一顿晚饭，花了194",
			{ messageId: "dinner", messageType: "voice" },
		);
		expect(reply).toContain("194.00");
		expect(db.prepare("SELECT status,cents FROM ledger_entries").get()).toEqual(
			{ status: "posted", cents: 19400 },
		);
		expect(createCoachReply).not.toHaveBeenCalled();
		const request = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(request).toMatchObject({
			model: "deepseek-v4-flash",
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			max_tokens: 3072,
		});
		expect(request.messages[0].content).toContain("今天一顿晚饭，花了194");
		expect(request.messages[0].content).not.toContain("{{today}}");
	});

	it.each(["http401", "empty", "malformed", "truncated", "timeout"])(
		"does not route %s classification failures into coaching",
		async (failure) => {
			const db = boot();
			const channel = createChannel(db, { type: "wechat" });
			const fetchMock = vi.fn().mockImplementation(async () => {
				if (failure === "timeout")
					throw new DOMException("Timeout", "TimeoutError");
				return {
					ok: failure !== "http401",
					status: 401,
					json: async () => ({
						choices: [
							{
								finish_reason: failure === "truncated" ? "length" : "stop",
								message: {
									content:
										failure === "empty"
											? ""
											: failure === "malformed"
												? "not json"
												: '{"intent":"insight"}',
								},
							},
						],
					}),
				};
			});
			vi.stubGlobal("fetch", fetchMock);
			const send = () =>
				handleInbound(db, config, channel, "alice", "今天一顿晚饭，花了194", {
					messageId: "failed",
				});
			expect(await send()).toContain("尚未保存");
			expect(await send()).toBe("");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(createCoachReply).not.toHaveBeenCalled();
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM conversations").get(),
			).toEqual({ n: 0 });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get(),
			).toEqual({ n: 0 });
		},
	);

	it("posts a voice expense automatically without a second AI call", async () => {
		const db = boot();
		const channel = createChannel(db, { type: "wechat", name: "测试" });
		const fetchMock = mockResult({ intent: "ledger", entry });
		const reply = await handleInbound(
			db,
			config,
			channel,
			"alice",
			"中午用微信吃饭花了三十五块",
			{ messageId: "voice1", messageType: "voice" },
		);
		expect(reply).toContain("已记账");
		expect(reply).toContain("35.00");
		expect(reply).toContain("微信");
		expect(db.prepare("SELECT status,cents FROM ledger_entries").get()).toEqual(
			{ status: "posted", cents: 3500 },
		);
		expect(createCoachReply).not.toHaveBeenCalled();
		await handleInbound(db, config, channel, "alice", "确认记账", {
			messageId: "confirm1",
		});
		expect(db.prepare("SELECT status FROM ledger_entries").get()).toEqual({
			status: "posted",
		});
		expect(
			await handleInbound(
				db,
				config,
				channel,
				"alice",
				"中午用微信吃饭花了三十五块",
				{ messageId: "voice1" },
			),
		).toBe("");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("routes emotional content to insights without creating financial data", async () => {
		const db = boot();
		const channel = createChannel(db, { type: "wechat" });
		mockResult({ intent: "insight" });
		await handleInbound(db, config, channel, "alice", "花了两千很后悔", {
			messageId: "m1",
			messageType: "voice",
		});
		expect(createCoachReply).not.toHaveBeenCalled();
		expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual(
			{ n: 1 },
		);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get(),
		).toEqual({ n: 0 });
	});

	it("clarifies mixed needs and preserves safety priority", async () => {
		const db = boot();
		const channel = createChannel(db, { type: "wechat" });
		const fetchMock = mockResult({ intent: "clarify" });
		expect(
			await handleInbound(db, config, channel, "alice", "午饭35车费20还很烦", {
				messageId: "m1",
			}),
		).toContain("请补充说明");
		await handleInbound(db, config, channel, "alice", "欠了钱，现在就想死", {
			messageId: "m2",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(createCoachReply).not.toHaveBeenCalled();
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get(),
		).toEqual({ n: 0 });
	});

	it.each(["-35", "1.234", "0"])(
		"rejects invalid extracted amount %s",
		async (amount) => {
			const db = boot();
			mockResult({ intent: "ledger", entry: { ...entry, amount } });
			expect(await recognizeIntent(db, config, "一笔开销")).toBeNull();
		},
	);

	it("refuses invalid/future dates and degrades safely on HTTP failure", async () => {
		const db = boot();
		for (const date of ["2026-02-30", "9999-01-01"]) {
			mockResult({ intent: "ledger", entry: { ...entry, date } });
			expect(await recognizeIntent(db, config, "一笔开销")).toEqual(
				date === "2026-02-30" ? null : { intent: "clarify" },
			);
		}
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 401 }),
		);
		expect(await recognizeIntent(db, config, "午饭三十五")).toBeNull();
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get(),
		).toEqual({ n: 0 });
	});
});
