import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../db.js";
import { activeSetting } from "../http/settings.js";
import { type ConversationFilters, moodSample } from "../im/insights.js";
import { promptConfig } from "./prompt-config.js";

const section = z.string().trim().min(1).max(1200);
export const moodAnalysisSchema = z
	.object({
		current: section,
		changes: section,
		traits: section,
		advice: section,
		limitations: section,
		evidenceIds: z.array(z.string().min(1)).min(1).max(5),
	})
	.strict();
// 同一数据库、同一快照并发查询只调用一次模型；失败不缓存。
const running = new WeakMap<SqliteDb, Map<string, Promise<unknown>>>();
export async function analyseMood(
	db: SqliteDb,
	config: AppConfig,
	filters: ConversationFilters,
) {
	if (!filters.channelId || !filters.contactId)
		throw new Error("PERSON_REQUIRED");
	const sample = moodSample(db, filters, promptConfig.mood.sampleLimit);
	if (!sample.rows.length) throw new Error("NO_MOOD_RECORDS");
	const model = activeSetting(db, config, "model", "regular");
	if (!model?.secret) throw new Error("MODEL_UNAVAILABLE");
	const modelName = String(model.config.model ?? "");
	const payload = sample.rows.map((r) => ({
		id: r.id,
		at: r.created_at,
		safety: r.safety_level,
		text: r.user_text.slice(0, 2000),
	}));
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				filters,
				sample.total,
				payload,
				model.id,
				modelName,
				promptConfig.mood,
			]),
		)
		.digest("hex");
	const cached = db
		.prepare("SELECT result_json FROM mood_analyses WHERE cache_key=?")
		.get(key) as { result_json: string } | undefined;
	if (cached) return JSON.parse(cached.result_json);
	let pending = running.get(db);
	if (!pending) {
		pending = new Map();
		running.set(db, pending);
	}
	const previous = pending.get(key);
	if (previous) return previous;
	const job = (async () => {
		try {
			const response = await fetch(
				`${String(model.config.baseUrl ?? "").replace(/\/$/, "")}/chat/completions`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${model.secret}`,
					},
					body: JSON.stringify({
						model: modelName,
						temperature: 0,
						...(/^deepseek-v4-(?:flash|pro)$/.test(modelName)
							? {
									thinking: { type: "disabled" },
									response_format: { type: "json_object" },
								}
							: {}),
						max_tokens: promptConfig.mood.maxTokens,
						messages: [
							{ role: "system", content: promptConfig.mood.system },
							{ role: "user", content: JSON.stringify(payload) },
						],
					}),
					signal: AbortSignal.timeout(promptConfig.mood.requestTimeoutMs),
				},
			);
			if (!response.ok) {
				console.warn(`[mood] unavailable: http_${response.status}`);
				throw new Error("MODEL_UNAVAILABLE");
			}
			const body = (await response.json()) as {
				choices?: { finish_reason?: string; message?: { content?: unknown } }[];
			};
			const choice = body.choices?.[0];
			if (
				choice?.finish_reason === "length" ||
				typeof choice?.message?.content !== "string"
			)
				throw new Error("INVALID_OUTPUT");
			const analysis = moodAnalysisSchema.parse(
				JSON.parse(
					choice.message.content
						.trim()
						.replace(/^```(?:json)?\s*([\s\S]*?)```$/, "$1"),
				),
			);
			if (
				analysis.evidenceIds.some((id) => !sample.rows.some((r) => r.id === id))
			)
				throw new Error("INVALID_EVIDENCE");
			const result = {
				analysis,
				model: modelName,
				generatedAt: new Date().toISOString(),
				sampleCount: sample.rows.length,
				totalCount: sample.total,
				firstAt: sample.rows[0]?.created_at,
				lastAt: sample.rows.at(-1)?.created_at,
				truncated:
					sample.total > sample.rows.length ||
					sample.rows.some((r) => r.user_text.length > 2000),
				evidence: payload.filter((r) => analysis.evidenceIds.includes(r.id)),
			};
			db.prepare(
				"INSERT OR REPLACE INTO mood_analyses(cache_key,result_json,created_at) VALUES(?,?,?)",
			).run(key, JSON.stringify(result), result.generatedAt);
			return result;
		} catch {
			console.warn("[mood] unavailable: request_or_output_failed");
			throw new Error("MODEL_UNAVAILABLE");
		} finally {
			pending.delete(key);
		}
	})();
	pending.set(key, job);
	return job;
}
