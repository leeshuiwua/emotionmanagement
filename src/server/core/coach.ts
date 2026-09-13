import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../db.js";
import { activeSetting } from "../http/settings.js";
import { promptConfig } from "./prompt-config.js";
import { classifySafety, crisisResponse } from "./safety.js";

function fallback(): string {
	return promptConfig.replies.fallback;
}

export async function createCoachReply(
	db: SqliteDb,
	config: AppConfig,
	text: string,
): Promise<{
	level: ReturnType<typeof classifySafety>;
	text: string;
	source: "safety" | "model" | "fallback";
}> {
	const level = classifySafety(text);
	if (level === "HIGH" || level === "IMMINENT")
		return { level, text: crisisResponse(level), source: "safety" };
	const model = activeSetting(db, config, "model", "regular");
	if (!model?.secret) {
		console.warn("[coach] fallback: model_not_configured");
		return { level, text: fallback(), source: "fallback" };
	}
	const baseUrl = String(model.config.baseUrl ?? "").replace(/\/$/, "");
	const modelName = String(model.config.model ?? "");
	let failureReason = "network_or_response_error";
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${model.secret}`,
			},
			body: JSON.stringify({
				model: modelName,
				temperature: 0.5,
				messages: [
					{ role: "system", content: promptConfig.systemPrompt },
					{ role: "user", content: text },
				],
			}),
			signal: AbortSignal.timeout(promptConfig.coach.requestTimeoutMs),
		});
		if (!response.ok) {
			failureReason = `http_${response.status}`;
			throw new Error("model HTTP error");
		}
		const body = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const rawContent = body.choices?.[0]?.message?.content;
		const content = typeof rawContent === "string" ? rawContent.trim() : "";
		if (!content) {
			failureReason = "empty_or_invalid_response";
			throw new Error("empty model response");
		}
		return { level, text: content, source: "model" };
	} catch (error) {
		if (
			error instanceof Error &&
			["TimeoutError", "AbortError"].includes(error.name)
		) {
			failureReason = "timeout";
		}
		// 只记录分类，不输出来信、模型正文、地址或凭据。
		console.warn(`[coach] fallback: ${failureReason}`);
		return { level, text: fallback(), source: "fallback" };
	}
}
