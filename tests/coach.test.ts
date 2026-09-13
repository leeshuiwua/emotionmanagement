import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { createCoachReply } from "../src/server/core/coach.js";
import { promptConfig } from "../src/server/core/prompt-config.js";
import type { SqliteDb } from "../src/server/db.js";

vi.mock("../src/server/http/settings.js", () => ({
	activeSetting: () => ({
		secret: "test-key",
		config: { baseUrl: "https://model.example/v1", model: "test-model" },
	}),
}));

const db = {} as SqliteDb;
const config = {} as AppConfig;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("coach system prompt", () => {
	it("sends the shared prompt before the unmodified incoming text", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				choices: [
					{ message: { content: "可以先写下你希望对方理解的一件事。" } },
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const text = "今天开会意见没被听进去，有点委屈。";
		const result = await createCoachReply(db, config, text);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.messages).toEqual([
			{ role: "system", content: promptConfig.systemPrompt },
			{ role: "user", content: text },
		]);
		expect(result.source).toBe("model");
		expect(timeoutSpy).toHaveBeenCalledWith(
			promptConfig.coach.requestTimeoutMs,
		);
		expect(result.text).toBe("可以先写下你希望对方理解的一件事。");
	});

	it("returns a brief transparent fallback on model failure", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const result = await createCoachReply(db, config, "今天开会不顺利。");
		expect(result.source).toBe("fallback");
		expect(Array.from(result.text).length).toBeLessThanOrEqual(100);
		expect(result.text).toContain("暂时无法生成");
	});

	it("keeps urgent safety responses ahead of the regular model", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = await createCoachReply(db, config, "现在就想死");
		expect(result.source).toBe("safety");
		expect(result.text).toContain("110/120");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"empty",
			{ ok: true, json: async () => ({ choices: [] }) },
			"empty_or_invalid_response",
		],
		["HTTP", { ok: false, status: 503 }, "http_503"],
	])(
		"reports %s failures without exposing incoming text",
		async (_name, response, reason) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await createCoachReply(db, config, "私人来信内容");
			expect(result.source).toBe("fallback");
			expect(result.text.length).toBeGreaterThan(0);
			expect(warn).toHaveBeenCalledExactlyOnceWith(
				`[coach] fallback: ${reason}`,
			);
		},
	);
});
