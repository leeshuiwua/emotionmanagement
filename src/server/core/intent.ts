import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../db.js";
import { activeSetting } from "../http/settings.js";
import { chinaDate, entrySchema } from "../ledger.js";
import { promptConfig, renderPromptTemplate } from "./prompt-config.js";

const intentSchema = z.discriminatedUnion("intent", [
	z.object({ intent: z.literal("insight") }).strict(),
	z.object({ intent: z.literal("clarify") }).strict(),
	z.object({ intent: z.literal("unsupported") }).strict(),
	z
		.object({
			intent: z.literal("both"),
			entries: z.array(entrySchema).min(1).max(10),
		})
		.strict(),
	z
		.object({
			intent: z.literal("ledger"),
			entries: z.array(entrySchema).min(1).max(10),
		})
		.strict(),
]);
export type MessageIntent = z.infer<typeof intentSchema>;

/** null 表示服务不可用，不应当作心理倾诉，也不允许生成财务写入。 */
export async function recognizeIntent(
	db: SqliteDb,
	config: AppConfig,
	text: string,
): Promise<MessageIntent | null> {
	const model = activeSetting(db, config, "model", "regular");
	if (!model?.secret) {
		console.warn("[intent] unavailable: model_not_configured");
		return null;
	}
	const modelName = String(model.config.model ?? "");
	try {
		const today = chinaDate();
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
					// DeepSeek V4 默认思考；分类不需要推理文本，显式关闭并约束输出。
					...(/^deepseek-v4-(?:flash|pro)$/.test(modelName)
						? {
								thinking: { type: "disabled" },
								response_format: { type: "json_object" },
								max_tokens: promptConfig.intent.maxTokens,
							}
						: {}),
					temperature: 0,
					messages: [
						{
							role: "system",
							content: renderPromptTemplate(promptConfig.intent.system, {
								today,
							}),
						},
						{ role: "user", content: text },
					],
				}),
				signal: AbortSignal.timeout(promptConfig.intent.requestTimeoutMs),
			},
		);
		if (!response.ok) {
			console.warn(`[intent] unavailable: http_${response.status}`);
			return null;
		}
		const body = (await response.json()) as {
			choices?: { finish_reason?: string; message?: { content?: unknown } }[];
		};
		if (body.choices?.[0]?.finish_reason === "length") {
			console.warn("[intent] unavailable: truncated_response");
			return null;
		}
		const content = body.choices?.[0]?.message?.content;
		if (typeof content !== "string") throw new Error("invalid response");
		const raw = content
			.trim()
			.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1");
		const value = JSON.parse(raw);
		// 兼容旧单笔结构；数值金额不舍入，最终统一严格校验。
		if (["ledger", "both"].includes(value?.intent)) {
			if (value.entry && !value.entries) {
				value.entries = [value.entry];
				delete value.entry;
			}
			if (Array.isArray(value.entries))
				for (const entry of value.entries)
					if (entry && typeof entry.amount === "number")
						entry.amount = String(entry.amount);
		}
		const parsed = intentSchema.safeParse(value);
		if (!parsed.success) {
			console.warn("[intent] unavailable: invalid_schema");
			return null;
		}
		if (
			(parsed.data.intent === "ledger" || parsed.data.intent === "both") &&
			parsed.data.entries.some((entry) => entry.date > today)
		)
			return { intent: "clarify" };
		return parsed.data;
	} catch {
		console.warn("[intent] unavailable: network_timeout_or_invalid_response");
		return null;
	}
}
