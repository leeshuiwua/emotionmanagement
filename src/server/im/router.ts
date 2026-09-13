// 模型调用在事务外；分流后一次事务写入，心情保存不等待心理回复。
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { recognizeIntent } from "../core/intent.js";
import { promptConfig } from "../core/prompt-config.js";
import { classifySafety, crisisResponse } from "../core/safety.js";
import { audit, nowIso, type SqliteDb } from "../db.js";
import { handleLedgerMessage } from "../ledger.js";
import type { ImChannel } from "./store.js";
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
	const receipt = JSON.stringify([channel.id, externalId, messageId]);
	const legacyKey = `wechat:${channel.id}:${messageId}`;
	const dedupeKey = `wechat:${receipt}`;
	const seen = () =>
		Boolean(
			db.prepare("SELECT 1 FROM ledger_receipts WHERE id=?").get(receipt) ||
				db
					.prepare("SELECT 1 FROM inbound_messages WHERE dedupe_key IN (?,?)")
					.get(dedupeKey, legacyKey),
		);
	if (seen()) return "";
	const safety = classifySafety(trimmed);
	const urgent = safety === "HIGH" || safety === "IMMINENT";
	if (!urgent && ["查账", "确认记账", "取消记账"].includes(trimmed)) {
		const direct = handleLedgerMessage(
			db,
			channel.id,
			externalId,
			trimmed,
			messageId,
		);
		if (direct !== null) return direct;
	}
	const intent = urgent
		? { intent: "insight" as const }
		: await recognizeIntent(db, config, trimmed);
	return db.transaction(() => {
		if (seen()) return "";
		if (
			intent === null ||
			intent.intent === "clarify" ||
			intent.intent === "unsupported"
		) {
			db.prepare("INSERT INTO ledger_receipts(id) VALUES(?)").run(receipt);
			audit(db, {
				actorType: "SYSTEM",
				action: "MESSAGE_ROUTED",
				resourceType: "IM_CHANNEL",
				resourceId: channel.id,
				detail: { intent: intent?.intent ?? "unavailable" },
			});
			return intent === null
				? promptConfig.intent.unavailable
				: intent.intent === "unsupported"
					? promptConfig.intent.unsupported
					: promptConfig.intent.clarification;
		}
		let ledgerReply = "";
		if (intent.intent === "ledger" || intent.intent === "both") {
			ledgerReply =
				handleLedgerMessage(
					db,
					channel.id,
					externalId,
					trimmed,
					messageId,
					intent.entries,
				) ?? "";
			if (intent.intent === "ledger") return ledgerReply;
		}
		const now = nowIso();
		const inboundId = randomUUID();
		const userId = createHash("sha256")
			.update(`${channel.id}:${externalId}`)
			.digest("hex");
		db.prepare(`INSERT INTO inbound_messages
   (id,dedupe_key,app_id,open_id,message_type,content,raw_xml,received_at) VALUES(?,?,?,?,?,?,?,?)`).run(
			inboundId,
			dedupeKey,
			channel.id,
			externalId,
			meta.messageType === "voice" ? "voice" : "text",
			trimmed,
			JSON.stringify({ source: "wechat", messageId }),
			now,
		);
		db.prepare(`INSERT INTO wechat_users(id,app_id,open_id,subscribed,created_at,updated_at)
   VALUES(?,?,?,1,?,?) ON CONFLICT(app_id,open_id) DO UPDATE SET subscribed=1,updated_at=excluded.updated_at`).run(
			userId,
			channel.id,
			externalId,
			now,
			now,
		);
		const reply = urgent
			? crisisResponse(safety as "HIGH" | "IMMINENT")
			: promptConfig.mood.saved;
		const id = randomUUID();
		db.prepare(`INSERT INTO conversations(id,user_id,inbound_message_id,user_text,safety_level,assistant_text,created_at,completed_at)
   VALUES(?,?,?,?,?,?,?,?)`).run(
			id,
			userId,
			inboundId,
			trimmed,
			safety,
			reply,
			now,
			now,
		);
		audit(db, {
			actorType: "WECHAT_USER",
			actorId: userId,
			action: "MOOD_RECORDED",
			resourceType: "CONVERSATION",
			resourceId: id,
			detail: { safetyLevel: safety, intent: intent.intent },
		});
		return intent.intent === "both" && !urgent
			? promptConfig.mood.bothSaved
			: [ledgerReply, reply].filter(Boolean).join("\n");
	})();
}
