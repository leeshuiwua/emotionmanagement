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
			? "你的安全现在是最重要的。"
			: "听起来你正承受很强的痛苦，谢谢你告诉我。";
	return `${urgency}\n\n请先离开可能伤害自己或他人的物品，到有人的地方，并立即联系一位你信任的人陪在身边。如果危险迫在眉睫，请立即拨打当地紧急电话（中国大陆：110/120）或前往最近急诊。\n\n你现在是否已经有具体计划、工具，或正独自一人？`;
}
