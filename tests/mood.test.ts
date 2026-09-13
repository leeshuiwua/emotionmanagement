import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { analyseMood } from "../src/server/core/mood.js";
import { openDatabase } from "../src/server/db.js";
import { listContactProfiles, moodSample } from "../src/server/im/insights.js";

vi.mock("../src/server/http/settings.js", () => ({
	activeSetting: () => ({
		id: "m1",
		secret: "test",
		config: { baseUrl: "https://model.example/v1", model: "deepseek-v4-flash" },
	}),
}));
const databases: ReturnType<typeof openDatabase>[] = [];
function boot() {
	const db = openDatabase(":memory:");
	databases.push(db);
	db.prepare(
		"INSERT INTO wechat_users(id,app_id,open_id,created_at,updated_at) VALUES('u','c','a','2026-09-01','2026-09-01')",
	).run();
	return db;
}
function add(
	db: ReturnType<typeof openDatabase>,
	id: string,
	contact = "a",
	at = "2026-09-01T12:00:00.000Z",
) {
	db.prepare(
		"INSERT INTO inbound_messages(id,dedupe_key,app_id,open_id,message_type,content,raw_xml,received_at) VALUES(?,?,'c',?,'text','今天开心','{}',?)",
	).run(id, id, contact, at);
	db.prepare(
		"INSERT INTO conversations(id,user_id,inbound_message_id,user_text,safety_level,created_at) VALUES(?,'u',?,'今天开心','NONE',?)",
	).run(id, id, at);
}
const filters = { channelId: "c", contactId: "a" };
const output = {
	current: "最近表达了开心",
	changes: "还不足以判断变化",
	traits: "样本不足，不能判断稳定性格",
	advice: "记下今天让你开心的具体事情",
	limitations: "仅供自我回顾，非医学诊断",
	evidenceIds: ["one"],
};
afterEach(() => {
	vi.unstubAllGlobals();
	for (const db of databases.splice(0)) db.close();
});
describe("personal mood analysis", () => {
	it("selects recent samples without pooling people or dropping old users from the directory", () => {
		const db = boot();
		db.transaction(() => {
			for (let i = 0; i < 2051; i++)
				add(
					db,
					`row${i}`,
					"a",
					new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
				);
			add(db, "other", "b");
		})();
		const sample = moodSample(db, filters, 50);
		expect(sample.total).toBe(2051);
		expect(sample.rows).toHaveLength(50);
		expect(sample.rows.at(-1)?.id).toBe("row2050");
		expect(sample.rows.some((r) => r.id === "other")).toBe(false);
		expect(listContactProfiles(db, {})).toHaveLength(2);
	});
	it("caches identical snapshots, merges concurrent calls and invalidates on a new record", async () => {
		const db = boot();
		add(db, "one");
		add(db, "other", "b");
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: JSON.stringify(output) } }],
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const [first, second] = await Promise.all([
			analyseMood(db, {} as AppConfig, filters),
			analyseMood(db, {} as AppConfig, filters),
		]);
		expect(first).toEqual(second);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(first).toMatchObject({
			sampleCount: 1,
			totalCount: 1,
			evidence: [{ id: "one" }],
		});
		await analyseMood(db, {} as AppConfig, filters);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		add(db, "two", "a", "2026-09-02T00:00:00.000Z");
		await analyseMood(db, {} as AppConfig, filters);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it.each(["foreign_evidence", "invalid_json", "http401"])(
		"rejects %s and leaves original records intact",
		async (kind) => {
			const db = boot();
			add(db, "one");
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({
					ok: kind !== "http401",
					status: 401,
					json: async () => ({
						choices: [
							{
								message: {
									content:
										kind === "invalid_json"
											? "bad"
											: JSON.stringify({
													...output,
													evidenceIds: ["another-person"],
												}),
								},
							},
						],
					}),
				})),
			);
			await expect(analyseMood(db, {} as AppConfig, filters)).rejects.toThrow(
				"MODEL_UNAVAILABLE",
			);
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM mood_analyses").get(),
			).toEqual({ n: 0 });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM conversations").get(),
			).toEqual({ n: 1 });
		},
	);
	it("refuses unscoped or empty-person analysis before calling a model", async () => {
		const db = boot();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(analyseMood(db, {} as AppConfig, {})).rejects.toThrow(
			"PERSON_REQUIRED",
		);
		await expect(analyseMood(db, {} as AppConfig, filters)).rejects.toThrow(
			"NO_MOOD_RECORDS",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
