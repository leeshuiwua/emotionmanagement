import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePromptConfig } from "../src/server/core/prompt-config.js";

const xml = readFileSync(
	new URL("../src/server/config/prompts.xml", import.meta.url),
	"utf8",
);

describe("XML prompt configuration", () => {
	it("applies a changed character limit throughout the system prompt", () => {
		const config = parsePromptConfig(
			xml.replace(
				"<maxCharacters>100</maxCharacters>",
				"<maxCharacters>80</maxCharacters>",
			),
		);
		expect(config.systemPrompt).toContain("80字");
		expect(config.systemPrompt).not.toContain("100字");
		expect(config.systemPrompt).not.toContain("{{");
		expect(config.systemPrompt).toContain("《道德经》");
	});

	it("rejects broken XML, missing fields, invalid limits and unknown placeholders", () => {
		for (const invalid of [
			xml.replace("</prompts>", ""),
			xml.replace(/<fallback>.*?<\/fallback>/s, ""),
			xml.replace(
				"<maxCharacters>100</maxCharacters>",
				"<maxCharacters>0</maxCharacters>",
			),
			xml.replace("{{maxCharacters}}", "{{unknown}}"),
			xml.replace("{{body}}", ""),
			`<!DOCTYPE prompts SYSTEM "file:///etc/passwd">${xml}`,
		])
			expect(() => parsePromptConfig(invalid)).toThrow();
	});
});
