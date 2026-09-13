import type { SqliteDb } from "../db.js";
export type ConversationFilters = {
	from?: string;
	to?: string;
	channelId?: string;
	contactId?: string;
};
export type MoodRow = {
	id: string;
	user_text: string;
	safety_level: string;
	created_at: string;
};
function where(filters: ConversationFilters) {
	const clauses: string[] = [],
		values: string[] = [];
	for (const [key, column] of [
		["from", "c.created_at >="],
		["to", "c.created_at <="],
		["channelId", "m.app_id ="],
		["contactId", "m.open_id ="],
	] as const) {
		if (filters[key]) {
			clauses.push(`${column} ?`);
			values.push(filters[key]);
		}
	}
	return {
		sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
		values,
	};
}
const base =
	"FROM conversations c JOIN inbound_messages m ON m.id=c.inbound_message_id LEFT JOIN im_channels ch ON ch.id=m.app_id";
const identity = `m.app_id AS channelId, COALESCE(ch.name,'已删除渠道') AS channelName,
 json_extract(ch.config,'$.userId') AS wechatAccountId, m.open_id AS contactId`;
const label = (id: string) =>
	id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`;
export function listConversationRecords(
	db: SqliteDb,
	filters: ConversationFilters,
	page: number,
	pageSize: number,
) {
	const w = where(filters);
	const { total } = db
		.prepare(`SELECT COUNT(*) AS total ${base} ${w.sql}`)
		.get(...w.values) as { total: number };
	const rows = db
		.prepare(`SELECT c.id, ${identity}, m.message_type AS messageType, c.user_text AS userText,
 c.assistant_text AS assistantText, c.safety_level AS safetyLevel, c.created_at AS createdAt
 ${base} ${w.sql} ORDER BY c.created_at DESC,c.rowid DESC LIMIT ? OFFSET ?`)
		.all(...w.values, pageSize, (page - 1) * pageSize) as Array<
		{ contactId: string } & Record<string, unknown>
	>;
	return {
		items: rows.map((r) => ({ ...r, contactLabel: label(r.contactId) })),
		total,
		page,
		pageSize,
	};
}
export function listContactProfiles(
	db: SqliteDb,
	filters: ConversationFilters,
) {
	const w = where(filters);
	const rows = db
		.prepare(`SELECT ${identity},COUNT(*) AS messageCount,MIN(c.created_at) AS firstSeenAt,
 MAX(c.created_at) AS lastSeenAt,SUM(c.safety_level IN ('HIGH','IMMINENT')) AS highRiskCount
 ${base} ${w.sql} GROUP BY m.app_id,m.open_id ORDER BY lastSeenAt DESC,m.app_id,m.open_id`)
		.all(...w.values) as Array<{ contactId: string } & Record<string, unknown>>;
	return rows.map((r) => ({ ...r, contactLabel: label(r.contactId) }));
}
export function moodSample(
	db: SqliteDb,
	filters: ConversationFilters,
	limit: number,
) {
	const w = where(filters);
	const { total } = db
		.prepare(`SELECT COUNT(*) AS total ${base} ${w.sql}`)
		.get(...w.values) as { total: number };
	const rows = db
		.prepare(`SELECT c.id,c.user_text,c.safety_level,c.created_at ${base} ${w.sql}
 ORDER BY c.created_at DESC,c.rowid DESC LIMIT ?`)
		.all(...w.values, limit) as MoodRow[];
	return { total, rows: rows.reverse() };
}
