// 渠道生命周期管理：根据 DB 中的渠道配置，拉起/停止个人微信的长轮询。
import type { AppConfig } from "../config.js";
import type { SqliteDb } from "../db.js";
import { handleInbound } from "./router.js";
import { type ImChannel, listChannels, setCursor } from "./store.js";
import {
	createWechatPersonalAdapter,
	type IlinkMessage,
	type WechatPersonalAdapter,
} from "./wechat.js";

const running = new Map<
	string,
	{ adapter: WechatPersonalAdapter; sig: string }
>();

function signatureOf(ch: ImChannel): string {
	return JSON.stringify([ch.enabled, ch.config]);
}

function hooksFor(db: SqliteDb, config: AppConfig, ch: ImChannel) {
	return {
		onMessage: (
			externalId: string,
			text: string,
			meta: {
				contextToken?: string;
				raw?: IlinkMessage;
				messageType: "text" | "voice";
			},
		) =>
			handleInbound(db, config, ch, externalId, text, {
				contextToken: meta.contextToken,
				messageId: meta.raw?.message_id,
				messageType: meta.messageType,
			}),
		persistCursor: (cursor: string) => {
			try {
				setCursor(db, ch.id, cursor);
			} catch {
				// cursor 持久化失败不影响主流程
			}
		},
		log: (msg: string) => console.log(msg),
	};
}

/** 渠道行（含 DB 持久化的 cursor）→ 长轮询适配器 */
export function createAdapter(
	db: SqliteDb,
	config: AppConfig,
	ch: ImChannel,
): WechatPersonalAdapter | null {
	if (ch.type !== "wechat") return null;
	if (!ch.config.token) return null;
	return createWechatPersonalAdapter(
		{
			token: ch.config.token,
			baseUrl: ch.config.baseUrl,
			cursor: ch.cursor,
		},
		hooksFor(db, config, ch),
	);
}

/** 让后台轮询进程与数据库中的渠道配置保持一致（幂等，可反复调用） */
export function syncChannels(db: SqliteDb, config: AppConfig): void {
	let channels: ImChannel[] = [];
	try {
		channels = listChannels(db);
	} catch {
		return; // 迁移尚未就绪（极端时序），下次调用再同步
	}
	const wanted = new Map(
		channels
			.filter((c) => c.enabled && c.config.token)
			.map((c) => [c.id, c] as const),
	);

	for (const [id, entry] of [...running]) {
		const target = wanted.get(id);
		if (!target || signatureOf(target) !== entry.sig) {
			entry.adapter.stop();
			running.delete(id);
		}
	}
	for (const [id, ch] of wanted) {
		if (running.has(id)) continue;
		const adapter = createAdapter(db, config, ch);
		if (!adapter) continue;
		adapter.start();
		running.set(id, { adapter, sig: signatureOf(ch) });
		console.log(`[im] wechat poller started: ${ch.name} (${id})`);
	}
}

export function stopAll(): void {
	for (const [, entry] of running) entry.adapter.stop();
	running.clear();
}

/** 测试用：当前活跃轮询器数量 */
export function activePollerCount(): number {
	return running.size;
}
