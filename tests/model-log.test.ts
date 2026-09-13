import { afterEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import { loggedModelFetch } from "../src/server/core/model-log.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("logs correlated request/response and exact token usage without leaking the key", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	const usage = {
		prompt_tokens: 100,
		completion_tokens: 20,
		total_tokens: 120,
		prompt_cache_hit_tokens: 80,
		prompt_cache_miss_tokens: 20,
		completion_tokens_details: { reasoning_tokens: 5 },
	};
	const body = {
		choices: [{ message: { content: "晚饭194 secret-example" } }],
		usage,
	};
	const request = {
		model: "deepseek-v4-flash",
		messages: [{ role: "user", content: "晚饭194 secret-example" }],
	};
	const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
	vi.stubGlobal("fetch", mock);
	const response = await loggedModelFetch(
		{} as AppConfig,
		"intent",
		"deepseek-v4-flash",
		"secret-example",
		"https://example.com",
		{
			method: "POST",
			headers: { authorization: "Bearer secret-example" },
			body: JSON.stringify(request),
		},
	);
	expect(await response.json()).toEqual(body);
	expect(mock).toHaveBeenCalledTimes(1);
	const events = log.mock.calls.map(([line]) =>
		JSON.parse(String(line).slice(8)),
	);
	expect(events[0].requestId).toBe(events[1].requestId);
	expect(events[0].request.messages[0].content).toContain("晚饭194");
	expect(events[1].usage).toEqual(usage);
	expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret-example");
});

it("keeps usage but excludes private request and response when content logging is disabled", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "private-reply" } }],
				}),
			),
		),
	);
	await loggedModelFetch(
		{ flashLogContent: false } as AppConfig,
		"mood",
		"deepseek-v4-flash",
		"key",
		"https://example.com",
		{ body: JSON.stringify({ messages: [{ content: "private-input" }] }) },
	);
	expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
	expect(JSON.parse(String(log.mock.calls[1][0]).slice(8)).usage).toBeNull();
});

it("logs HTTP failure bodies and preserves status", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ error: { message: "invalid api key" } }),
					{ status: 401 },
				),
			),
	);
	const response = await loggedModelFetch(
		{} as AppConfig,
		"intent",
		"deepseek-v4-flash",
		"secret",
		"https://example.com",
		{ body: "{}" },
	);
	expect(response.status).toBe(401);
	expect(response.ok).toBe(false);
	expect(String(log.mock.calls[1][0])).toContain("invalid api key");
});

it("reports timeouts without exposing error messages or inventing token consumption", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockRejectedValue(
				new DOMException("private credentials", "TimeoutError"),
			),
	);
	await expect(
		loggedModelFetch(
			{} as AppConfig,
			"coach",
			"deepseek-v4-flash",
			"key",
			"https://example.com",
			{ body: "{}" },
		),
	).rejects.toThrow();
	const event = JSON.parse(String(log.mock.calls[1][0]).slice(8));
	expect(event.error).toBe("timeout");
	expect(event.usage).toBeNull();
	expect(JSON.stringify(log.mock.calls)).not.toContain("private credentials");
});
