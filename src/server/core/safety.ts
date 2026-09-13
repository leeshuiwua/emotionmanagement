import { promptConfig, renderPromptTemplate } from "./prompt-config.js";

export type SafetyLevel = "NONE" | "CARE" | "HIGH" | "IMMINENT";

const imminent = [
	"现在就想死",
	"马上自杀",
	"已经准备好",
	"要杀了他",
	"正在割腕",
];
const high = ["不想活", "想死", "自杀", "自残", "杀人", "活着没意思"];
const care = ["绝望", "崩溃", "撑不住", "极度痛苦", "无法呼吸"];

export function classifySafety(text: string): SafetyLevel {
	const compact = text.toLowerCase().replace(/\s/g, "");
	if (imminent.some((term) => compact.includes(term))) return "IMMINENT";
	if (high.some((term) => compact.includes(term))) return "HIGH";
	if (care.some((term) => compact.includes(term))) return "CARE";
	return "NONE";
}

export function crisisResponse(level: "HIGH" | "IMMINENT"): string {
	const urgency =
		level === "IMMINENT"
			? promptConfig.replies.crisisImminent
			: promptConfig.replies.crisisHigh;
	return renderPromptTemplate(promptConfig.replies.crisisFormat, {
		urgency,
		body: promptConfig.replies.crisisBody,
	});
}
