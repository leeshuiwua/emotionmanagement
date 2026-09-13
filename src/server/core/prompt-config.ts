import { readFileSync } from "node:fs";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

const nonempty = z.string().trim().min(1);
const schema = z
	.object({
		intent: z
			.object({
				system: nonempty,
				clarification: nonempty,
				unavailable: nonempty,
				unsupported: nonempty,
				requestTimeoutMs: z.coerce.number().int().min(1000).max(60000),
				maxTokens: z.coerce.number().int().min(256).max(4096),
			})
			.strict(),
		mood: z
			.object({
				saved: nonempty,
				system: nonempty,
				requestTimeoutMs: z.coerce.number().int().min(1000).max(60000),
				maxTokens: z.coerce.number().int().min(256).max(4096),
				sampleLimit: z.coerce.number().int().min(1).max(100),
			})
			.strict(),
		ledger: z
			.object({
				none: nonempty,
				saved: nonempty,
				cancelled: nonempty,
				pending: nonempty,
				help: nonempty,
				preview: nonempty,
				summary: nonempty,
			})
			.strict(),
		coach: z
			.object({
				maxCharacters: z.coerce.number().int().min(1).max(8000),
				requestTimeoutMs: z.coerce
					.number()
					.int()
					.min(1000)
					.max(60000)
					.default(20000),
				section: z
					.array(z.object({ title: nonempty, text: nonempty }).strict())
					.min(1),
			})
			.strict(),
		replies: z
			.object({
				fallback: nonempty,
				crisisHigh: nonempty,
				crisisImminent: nonempty,
				crisisBody: nonempty,
				crisisFormat: nonempty,
			})
			.strict(),
	})
	.strict();

export function renderPromptTemplate(
	text: string,
	values: Record<string, string>,
): string {
	return text.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
		if (!Object.hasOwn(values, key))
			throw new Error(`未知提示词占位符：${key}`);
		return values[key] ?? "";
	});
}

export function parsePromptConfig(xml: string) {
	// 配置只需要文本和结构，拒绝 DTD 和外部实体。
	if (/<!DOCTYPE|<!ENTITY/i.test(xml))
		throw new Error("提示词 XML 不允许 DTD 或实体声明");
	const validation = XMLValidator.validate(xml);
	if (validation !== true)
		throw new Error(`提示词 XML 格式错误：${validation.err.msg}`);
	const parsed = new XMLParser({
		ignoreAttributes: false,
		ignoreDeclaration: true,
		parseTagValue: false,
		isArray: (_name, path) => path === "prompts.coach.section",
	}).parse(xml);
	const root = z.object({ prompts: schema }).strict().parse(parsed);
	const config = root.prompts;
	renderPromptTemplate(config.intent.system, { today: "2026-01-01" });
	renderPromptTemplate(config.ledger.preview, {
		date: "",
		kind: "",
		amount: "",
		category: "",
		account: "",
	});
	renderPromptTemplate(config.ledger.summary, {
		month: "",
		income: "",
		expense: "",
		net: "",
	});
	const values = { maxCharacters: String(config.coach.maxCharacters) };
	const systemPrompt = config.coach.section
		.map((section) =>
			renderPromptTemplate(`【${section.title}】\n${section.text}`, values),
		)
		.join("\n\n");
	for (const key of ["urgency", "body"]) {
		if (!config.replies.crisisFormat.includes(`{{${key}}}`))
			throw new Error(`危机回复格式缺少 ${key}`);
	}
	renderPromptTemplate(config.replies.crisisFormat, { urgency: "", body: "" });
	return { ...config, systemPrompt };
}

// 相对模块定位，开发源码和 dist 构建目录都不依赖启动时的工作目录。
export const promptConfig = parsePromptConfig(
	readFileSync(new URL("../config/prompts.xml", import.meta.url), "utf8"),
);
