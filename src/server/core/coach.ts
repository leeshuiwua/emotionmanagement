import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../db.js";
import { activeSetting } from "../http/settings.js";
import { classifySafety, crisisResponse } from "./safety.js";

const SYSTEM_PROMPT = `你是“观心镜”心理教练。使用中文，共情而清醒，不病理化、不做医疗诊断。
必须以五段输出：🌿 **当下之觉**、🔍 **认知棱镜**、🧠 **性格侧写**、📜 **古镜今照**、🧘 **今日觉知作业**。
明确区分事实与叙事；MBTI只做动态倾向推测；练习不超过50字；最后以一个开放式身体觉察问题收尾。`;

function fallback(text: string): string {
	return `🌿 **当下之觉**\n我听见了你此刻的感受。它也许很沉，但值得被认真看见。\n\n🔍 **认知棱镜**\n- **客观事实**：你记录了“${text.slice(0, 80)}${text.length > 80 ? "…" : ""}”。\n- **主观叙事**：当下对自己或结果的解释，还需要与可观察事实分开。\n- **教练视角**：先不急着下结论，为其他可能原因留出空间。\n\n🧠 **性格侧写**\n此刻你更像在用内倾情感检查这件事的意义。这是一种动态倾向，不是固定标签；它的阴面是容易把“事”收缩成“我”。\n\n📜 **古镜今照**\n《礼记》言：“喜怒哀乐之未发，谓之中。”情绪不是敌人，是来报信的波浪。此刻的小我可能在保护“不被否定”的需要。\n\n🧘 **今日觉知作业**\n写下一句纯事实，再写一句当下的解释，用竖线将它们分开。\n\n**且问此时心：在写下这段文字时，你的身体哪里最紧绷？**`;
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
	if (!model?.secret)
		return { level, text: fallback(text), source: "fallback" };
	const baseUrl = String(model.config.baseUrl ?? "").replace(/\/$/, "");
	const modelName = String(model.config.model ?? "");
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
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: text },
				],
			}),
			signal: AbortSignal.timeout(3_500),
		});
		if (!response.ok) throw new Error(`model status ${response.status}`);
		const body = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const content = body.choices?.[0]?.message?.content?.trim();
		if (!content) throw new Error("empty model response");
		return { level, text: content, source: "model" };
	} catch {
		return { level, text: fallback(text), source: "fallback" };
	}
}
