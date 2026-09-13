import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";

/** Log Flash calls without headers/URLs; never change the request or retry it. */
export async function loggedModelFetch(
	config: AppConfig,
	workload: "intent" | "mood" | "coach",
	model: string,
	secret: string,
	url: string,
	init: RequestInit,
) {
	const level =
		config.flashLogLevel ??
		(config.flashLogContent === false ? "summary" : "full");
	if (model !== "deepseek-v4-flash" || level === "off") return fetch(url, init);
	const requestId = randomUUID();
	const started = performance.now();
	const contentEnabled = level === "full";
	const redact = (value: string) => {
		const masked = secret ? value.split(secret).join("[REDACTED]") : value;
		return masked
			.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
			.replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]");
	};
	const write = (event: string, data: Record<string, unknown>) => {
		try {
			console.info(
				`[flash] ${redact(
					JSON.stringify({
						timestamp: new Date().toISOString(),
						requestId,
						workload,
						model,
						event,
						...data,
					}),
				)}`,
			);
		} catch {
			/* Logging must not interrupt business processing. */
		}
	};
	write("request", {
		method: init.method,
		contentEnabled,
		...(contentEnabled ? { request: JSON.parse(String(init.body)) } : {}),
	});
	try {
		const response = await fetch(url, init);
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			write("response", {
				status: response.status,
				ok: response.ok,
				durationMs: Math.round(performance.now() - started),
				usage: null,
				error: "invalid_json_or_body_read_failed",
			});
			if (response.ok) throw new Error("invalid_model_response");
			return {
				ok: response.ok,
				status: response.status,
				json: async () => null,
			};
		}
		const record =
			body && typeof body === "object" ? (body as Record<string, unknown>) : {};
		write("response", {
			status: response.status,
			ok: response.ok,
			durationMs: Math.round(performance.now() - started),
			usage: record.usage ?? null,
			...(contentEnabled ? { response: body } : {}),
		});
		return { ok: response.ok, status: response.status, json: async () => body };
	} catch (error) {
		write("error", {
			durationMs: Math.round(performance.now() - started),
			error:
				error instanceof Error &&
				["AbortError", "TimeoutError"].includes(error.name)
					? "timeout"
					: "network_or_response_error",
			usage: null,
		});
		throw error;
	}
}
