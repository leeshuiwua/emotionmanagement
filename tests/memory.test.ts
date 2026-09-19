import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { processMemoryTask } from "../src/server/memory/agent.js";
import {
	backfillMemory,
	beijingDay,
	clearMemory,
	personFor,
	recordEvent,
	shortMemory,
} from "../src/server/memory/store.js";
import { memoryView } from "../src/server/memory/view.js";

vi.mock("../src/server/http/settings.js", () => ({
	activeSetting: () => ({
		secret: "test",
		config: { baseUrl: "https://model.example", model: "deepseek-flash" },
	}),
}));
const databases: ReturnType<typeof openDatabase>[] = [];
const config = { flashLogLevel: "off" } as AppConfig;
function boot() {
	const db = openDatabase(":memory:");
	databases.push(db);
	return db;
}
function result(value: unknown) {
	return {
		ok: true,
		json: async () => ({
			choices: [{ message: { content: JSON.stringify(value) } }],
		}),
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const db of databases.splice(0)) db.close();
});

describe("account memory", () => {
	it("imports historical conversations idempotently and flags them for reclassification", () => {
		const db = boot();
		db.prepare(
			"INSERT INTO wechat_users(id,app_id,open_id,created_at,updated_at) VALUES('u','c','a','2020-01-01','2020-01-01')",
		).run();
		db.prepare(
			"INSERT INTO inbound_messages(id,dedupe_key,app_id,open_id,message_type,content,raw_xml,received_at) VALUES('old','old','c','a','text','测试','{}','2020-01-01T00:00:00Z')",
		).run();
		db.prepare(
			"INSERT INTO conversations(id,user_id,inbound_message_id,user_text,safety_level,created_at) VALUES('old','u','old','测试','NONE','2020-01-01T00:00:00Z')",
		).run();
		backfillMemory(db);
		backfillMemory(db);
		expect(
			db.prepare("SELECT message_id,legacy,processed FROM memory_events").all(),
		).toEqual([{ message_id: "history:old", legacy: 1, processed: 0 }]);
	});
	it("summarizes all historical batches instead of only the latest memory window", async () => {
		const db = boot(),
			p = personFor(db, "c", "a");
		for (let i = 0; i < 21; i++)
			recordEvent(
				db,
				p,
				String(i),
				`历史表达${i}`,
				"已记录心情",
				"insight",
				new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
			);
		const covered: string[] = [];
		const model = vi.fn(async (_url, options) => {
			const input = JSON.parse(JSON.parse(options.body).messages[1].content);
			if (input.events)
				return result({
					summary: "历史摘要",
					memories: input.events.map((e: { id: string; text: string }) => ({
						kind: "fact",
						text: e.text,
						evidenceIds: [e.id],
					})),
				});
			covered.push(...input.memories.map((f: { text: string }) => f.text));
			expect(input.population.messages).toBe(21);
			const evidenceIds = [
				input.previous.traits[0]?.evidenceIds[0] ??
					input.memories[0].evidenceIds[0],
				input.memories.at(-1).evidenceIds[0],
			];
			return result({
				overview: "长期观察",
				traits: [
					{
						title: "观察",
						observation: "跨批次证据",
						counterEvidence: "情境单一",
						evidenceIds,
					},
				],
				changes: "不足以判断",
				limitations: "非测评",
			});
		});
		vi.stubGlobal("fetch", model);
		await processMemoryTask(db, config, p, true);
		expect(memoryView(db, p.id)?.profile).toBeNull();
		await processMemoryTask(db, config, p, true);
		expect(covered).toHaveLength(21);
		expect(covered).toContain("历史表达0");
		expect(covered).toContain("历史表达20");
		expect(model).toHaveBeenCalledTimes(4);
		expect(memoryView(db, p.id)?.stale).toBe(false);
	});
	it("isolates accounts, deduplicates delivery and switches context at Beijing midnight", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T16:00:01Z"));
		const db = boot(),
			a = personFor(db, "c", "a"),
			b = personFor(db, "c", "b"),
			other = personFor(db, "other", "a");
		recordEvent(
			db,
			a,
			"1",
			"昨天",
			"已记录心情",
			"insight",
			"2026-09-19T15:59:59Z",
		);
		recordEvent(db, a, "2", "今天", "已记录心情", "insight");
		recordEvent(db, a, "2", "重复", "", "insight");
		recordEvent(db, b, "2", "其他人", "", "insight");
		expect(other.id).not.toBe(a.id);
		expect(beijingDay(new Date("2026-09-19T16:00:00Z"))).toBe("2026-09-20");
		expect(shortMemory(db, a.id).events.map((e) => e.text)).toEqual(["今天"]);
		expect(memoryView(db, a.id)?.counts).toMatchObject({
			messages: 2,
			days: 2,
		});
		clearMemory(db, a.id);
		expect(memoryView(db, a.id)?.counts.messages).toBe(0);
		expect(memoryView(db, b.id)?.counts.messages).toBe(1);
	});

	it("extracts evidence-backed memories and provides original dated sources to the profile", async () => {
		const db = boot(),
			p = personFor(db, "c", "a");
		recordEvent(
			db,
			p,
			"1",
			"散步让我平静下来",
			"已记录心情",
			"insight",
			"2025-01-01T00:00:00Z",
		);
		const event = shortMemory(db, p.id);
		expect(event.events).toHaveLength(0);
		const id = (
			db.prepare("SELECT id FROM memory_events").get() as { id: string }
		).id;
		const model = vi.fn(async (_url, options) => {
			const input = JSON.parse(JSON.parse(options.body).messages[1].content);
			if (input.events)
				return result({
					summary: "散步后放松",
					memories: [
						{ kind: "coping", text: "散步有助于放松", evidenceIds: [id] },
					],
				});
			expect(input.evidence).toEqual([
				{ id, at: "2025-01-01T00:00:00Z", text: "散步让我平静下来" },
			]);
			return result({
				overview: "表达了自我调节的尝试",
				traits: [
					{
						title: "调节方式",
						observation: "尝试散步",
						counterEvidence: "单次记录，尚不稳定",
						evidenceIds: [id],
					},
				],
				changes: "不足以判断变化",
				limitations: "非测评或诊断",
			});
		});
		vi.stubGlobal("fetch", model);
		await processMemoryTask(db, config, p, true);
		const view = memoryView(db, p.id);
		expect(view?.facts).toHaveLength(1);
		expect(view?.stale).toBe(false);
		expect(view?.profile?.analysis.traits[0].evidenceIds).toEqual([id]);
		expect(model).toHaveBeenCalledTimes(2);
	});

	it.each(["foreign", "ledger"])(
		"rejects %s evidence without partially saving extraction",
		async (kind) => {
			const db = boot(),
				p = personFor(db, "c", "a"),
				b = personFor(db, "c", "b");
			recordEvent(db, p, "1", "午饭20", "已记账", "ledger");
			recordEvent(db, b, "1", "开心", "已记录心情", "insight");
			const id = (
				db
					.prepare("SELECT id FROM memory_events WHERE person_id=?")
					.get(kind === "foreign" ? b.id : p.id) as { id: string }
			).id;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					result({
						summary: "摘要",
						memories: [
							{ kind: "pattern", text: "无效推断", evidenceIds: [id] },
						],
					}),
				),
			);
			await expect(processMemoryTask(db, config, p, true)).rejects.toThrow(
				"invalid_evidence",
			);
			expect(memoryView(db, p.id)?.facts).toHaveLength(0);
			expect(memoryView(db, p.id)?.counts.pending).toBe(1);
		},
	);

	it("does not resurrect deleted records when a model request finishes late", async () => {
		const db = boot(),
			p = personFor(db, "c", "a");
		recordEvent(db, p, "1", "开心", "已记录心情", "insight");
		const id = (
			db.prepare("SELECT id FROM memory_events").get() as { id: string }
		).id;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				clearMemory(db, p.id);
				return result({
					summary: "开心",
					memories: [{ kind: "fact", text: "开心", evidenceIds: [id] }],
				});
			}),
		);
		await processMemoryTask(db, config, p, true);
		expect(memoryView(db, p.id)).toMatchObject({
			profile: null,
			facts: [],
			counts: { messages: 0 },
			task: null,
		});
	});
});
