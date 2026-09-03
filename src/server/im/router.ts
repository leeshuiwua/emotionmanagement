// IM 入站消息统一入口：
// 1. 用 ilink message_id 做幂等键（INSERT OR IGNORE inbound_messages）
// 2. upsert wechat_users
// 3. 调 createCoachReply 得到回复（含安全分流）
// 4. 写 conversations
// 5. 返回回复文本，由 adapter 负责发送
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { createCoachReply } from "../core/coach.js";
import { audit, nowIso, type SqliteDb } from "../db.js";
import type { ImChannel } from "./store.js";

const UNCONFIGURED_HINT =
	"观心镜尚未启用 AI 模型，请联系管理员在后台配置模型后再来聊天。";

export async function handleInbound(
	db: SqliteDb,
	config: AppConfig,
	channel: ImChannel,
	externalId: string,
	text: string,
	meta: {
		contextToken?: string;
		messageId?: string | number;
		messageType?: "text" | "voice";
	} = {},
): Promise<string> {
	const trimmed = String(text ?? "")
		.trim()
		.slice(0, 8000);
	if (!trimmed) return "";

	const messageId =
		meta.messageId != null ? String(meta.messageId) : randomUUID();
	const dedupeKey = `wechat:${channel.id}:${messageId}`;
	const now = nowIso();
	const inboundId = randomUUID();
	const messageType = meta.messageType === "voice" ? "voice" : "text";

	const inserted = db
		.prepare(
			`INSERT OR IGNORE INTO inbound_messages
			(id, dedupe_key, app_id, open_id, message_type, content, raw_xml, received_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			inboundId,
			dedupeKey,
			channel.id,
			externalId,
			messageType,
			trimmed,
			JSON.stringify({
				source: "wechat",
				messageId,
				contextToken: meta.contextToken,
			}),
			now,
		);
	if (inserted.changes === 0) return ""; // 重复消息，忽略

	const userId = createHash("sha256")
		.update(`${channel.id}:${externalId}`)
		.digest("hex");
	db.prepare(
		`INSERT INTO wechat_users
		(id, app_id, open_id, subscribed, created_at, updated_at)
		VALUES (?, ?, ?, 1, ?, ?)
		ON CONFLICT(app_id, open_id) DO UPDATE SET subscribed = 1, updated_at = excluded.updated_at`,
	).run(userId, channel.id, externalId, now, now);

	try {
		const result = await createCoachReply(db, config, trimmed);
		const conversationId = randomUUID();
		db.prepare(
			`INSERT INTO conversations
			(id, user_id, inbound_message_id, user_text, safety_level, assistant_text, created_at, completed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			conversationId,
			userId,
			inboundId,
			trimmed,
			result.level,
			result.text,
			now,
			nowIso(),
		);
		audit(db, {
			actorType: "WECHAT_USER",
			actorId: userId,
			action: "COACH_REPLY_CREATED",
			resourceType: "CONVERSATION",
			resourceId: conversationId,
			detail: { safetyLevel: result.level, source: result.source },
		});
		return result.text;
	} catch (e) {
		audit(db, {
			actorType: "SYSTEM",
			action: "WECHAT_MESSAGE_FAILED",
			resourceType: "INBOUND_MESSAGE",
			resourceId: inboundId,
			detail: {
				error: e instanceof Error ? e.message : String(e),
			},
		});
		// 模型未配置时给出友好提示
		if (e instanceof Error && e.message.includes("AI_NOT_CONFIGURED"))
			return UNCONFIGURED_HINT;
		return "出错了，请稍后重试。";
	}
}
