let csrfToken = "";

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function setCsrfToken(value: string) {
	csrfToken = value;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const method = init.method?.toUpperCase() ?? "GET";
	const response = await fetch(`/admin-api/v1${path}`, {
		...init,
		credentials: "same-origin",
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(!["GET", "HEAD"].includes(method) && csrfToken
				? { "x-csrf-token": csrfToken }
				: {}),
			...init.headers,
		},
	});
	if (response.status === 204) return undefined as T;
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		if (response.status === 401 && path !== "/auth/login") {
			window.dispatchEvent(new Event("gxj:unauthorized"));
		}
		throw new ApiError(
			body.error?.message ?? body.message ?? `HTTP ${response.status}`,
			response.status,
			body.error?.code,
		);
	}
	return body as T;
}

/* ------------------------- IM 渠道 ------------------------- */

export type WechatChannelConfig = {
	token?: string;
	baseUrl?: string;
	userId?: string;
	botId?: string;
};

export type ImChannel = {
	id: string;
	type: "wechat";
	name: string;
	enabled: boolean;
	config: WechatChannelConfig;
	cursor: string | null;
	created_at: string;
	updated_at: string;
};

export type WechatLoginState = {
	channelId: string;
	status:
		| "qr_ready"
		| "scanned"
		| "need_verifycode"
		| "already_connected"
		| "confirmed"
		| "failed"
		| "timeout";
	message: string;
	qrcodeUrl: string;
	error: string | null;
	qrDataUrl?: string | null;
};

export type ConversationRecord = {
	id: string;
	channelId: string;
	channelName: string;
	wechatAccountId: string | null;
	contactId: string;
	contactLabel: string;
	userText: string;
	assistantText: string | null;
	safetyLevel: string;
	createdAt: string;
	emotionScore: number;
};

export type ContactProfile = {
	channelId: string;
	channelName: string;
	wechatAccountId: string | null;
	contactId: string;
	contactLabel: string;
	messageCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
	highRiskCount: number;
	mbti: string;
	confidence: "low" | "medium";
	dimensions: Array<{ pair: string; value: number }>;
	traits: string[];
	topEmotions: string[];
	emotion: {
		average: number;
		volatility: number;
		level: "stable" | "medium" | "high";
		trend: Array<{ date: string; score: number; messageCount: number }>;
	};
};

export const imApi = {
	listChannels: () => api<{ channels: ImChannel[] }>("/im/channels"),
	createChannel: (body: {
		type: "wechat";
		name?: string;
		enabled?: boolean;
		config?: Partial<WechatChannelConfig>;
	}) =>
		api<{ channel: ImChannel }>("/im/channels", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	updateChannel: (
		id: string,
		body: {
			name?: string;
			enabled?: boolean;
			config?: Partial<WechatChannelConfig>;
		},
	) =>
		api<{ channel: ImChannel }>(`/im/channels/${id}`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	deleteChannel: (id: string) =>
		api<{ ok: true }>(`/im/channels/${id}`, { method: "DELETE" }),
	testChannel: (id: string) =>
		api<{ ok: true }>(`/im/channels/${id}/test`, { method: "POST" }),

	// 个人微信扫码登录
	startWechatLogin: (id: string) =>
		api<WechatLoginState>(`/im/channels/${id}/wechat/login`, {
			method: "POST",
		}),
	wechatLoginState: (id: string) =>
		api<WechatLoginState>(`/im/channels/${id}/wechat/login`),
	submitWechatVerifyCode: (id: string, code: string) =>
		api<{ ok: true }>(`/im/channels/${id}/wechat/login/verify`, {
			method: "POST",
			body: JSON.stringify({ code }),
		}),
	cancelWechatLogin: (id: string) =>
		api<{ ok: true }>(`/im/channels/${id}/wechat/login`, {
			method: "DELETE",
		}),
	listConversations: (params: URLSearchParams) =>
		api<{
			items: ConversationRecord[];
			total: number;
			page: number;
			pageSize: number;
		}>(`/im/conversations?${params.toString()}`),
	listProfiles: (params: URLSearchParams) =>
		api<{ profiles: ContactProfile[] }>(`/im/profiles?${params.toString()}`),
};
