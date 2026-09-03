import type { SqliteDb } from "../db.js";

export type ConversationFilters = {
	from?: string;
	to?: string;
	channelId?: string;
	contactId?: string;
};

type ConversationRow = {
	id: string;
	channel_id: string;
	channel_name: string;
	wechat_account_id: string | null;
	contact_id: string;
	message_type: string;
	user_text: string;
	assistant_text: string | null;
	safety_level: string;
	created_at: string;
};

export type EmotionPoint = {
	date: string;
	score: number;
	messageCount: number;
};

const WORDS = {
	positive: [
		"开心",
		"高兴",
		"幸福",
		"放松",
		"期待",
		"感谢",
		"顺利",
		"喜欢",
		"安心",
		"希望",
		"好多了",
		"笑",
	],
	negative: [
		"难过",
		"痛苦",
		"失望",
		"焦虑",
		"害怕",
		"孤独",
		"生气",
		"愤怒",
		"崩溃",
		"累",
		"烦",
		"担心",
		"压力",
		"无助",
		"哭",
	],
	anxiety: ["焦虑", "担心", "害怕", "紧张", "不安", "压力", "怎么办"],
	anger: ["生气", "愤怒", "恼火", "讨厌", "气死", "凭什么"],
	sadness: ["难过", "痛苦", "失望", "孤独", "无助", "哭", "崩溃"],
};

function countWords(text: string, words: string[]): number {
	return words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
}

function emotionScore(text: string): number {
	const positive = countWords(text, WORDS.positive);
	const negative = countWords(text, WORDS.negative);
	const emphasis = Math.min(2, (text.match(/[!！?？]{2,}/g) ?? []).length);
	return Math.max(
		-100,
		Math.min(100, (positive - negative) * 22 - (negative ? emphasis * 6 : 0)),
	);
}

function maskId(id: string): string {
	if (id.length <= 10) return id;
	return `${id.slice(0, 5)}…${id.slice(-4)}`;
}

function buildWhere(filters: ConversationFilters): {
	sql: string;
	values: string[];
} {
	const clauses: string[] = [];
	const values: string[] = [];
	if (filters.from) {
		clauses.push("c.created_at >= ?");
		values.push(filters.from);
	}
	if (filters.to) {
		clauses.push("c.created_at <= ?");
		values.push(filters.to);
	}
	if (filters.channelId) {
		clauses.push("m.app_id = ?");
		values.push(filters.channelId);
	}
	if (filters.contactId) {
		clauses.push("m.open_id = ?");
		values.push(filters.contactId);
	}
	return {
		sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
		values,
	};
}

const BASE_FROM = `FROM conversations c
  JOIN inbound_messages m ON m.id = c.inbound_message_id
  LEFT JOIN im_channels ch ON ch.id = m.app_id`;
const BASE_SELECT = `SELECT c.id, m.app_id AS channel_id, COALESCE(ch.name, '已删除渠道') AS channel_name,
  json_extract(ch.config, '$.userId') AS wechat_account_id, m.open_id AS contact_id,
  m.message_type, c.user_text, c.assistant_text, c.safety_level, c.created_at ${BASE_FROM}`;

export function listConversationRecords(
	db: SqliteDb,
	filters: ConversationFilters,
	page: number,
	pageSize: number,
) {
	const where = buildWhere(filters);
	const totalRow = db
		.prepare(`SELECT COUNT(*) AS count ${BASE_FROM} ${where.sql}`)
		.get(...where.values) as { count: number };
	const total = totalRow.count;
	const rows = db
		.prepare(
			`${BASE_SELECT} ${where.sql} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
		)
		.all(...where.values, pageSize, (page - 1) * pageSize) as ConversationRow[];
	return {
		items: rows.map((row) => ({
			id: row.id,
			channelId: row.channel_id,
			channelName: row.channel_name,
			wechatAccountId: row.wechat_account_id,
			contactId: row.contact_id,
			contactLabel: maskId(row.contact_id),
			messageType: row.message_type === "voice" ? "voice" : "text",
			userText: row.user_text,
			assistantText: row.assistant_text,
			safetyLevel: row.safety_level,
			createdAt: row.created_at,
			emotionScore: emotionScore(row.user_text),
		})),
		total,
		page,
		pageSize,
	};
}

function tendencyScore(texts: string[], left: string[], right: string[]) {
	const all = texts.join("\n");
	const l = countWords(all, left);
	const r = countWords(all, right);
	const total = l + r;
	return {
		first: l >= r,
		strength: total ? Math.abs(l - r) / total : 0,
		evidence: total,
	};
}

function topEmotions(texts: string[]): string[] {
	const joined = texts.join("\n");
	const ranked = [
		["焦虑", countWords(joined, WORDS.anxiety)],
		["愤怒", countWords(joined, WORDS.anger)],
		["低落", countWords(joined, WORDS.sadness)],
		["积极", countWords(joined, WORDS.positive)],
	] as Array<[string, number]>;
	return ranked
		.filter(([, count]) => count > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([name]) => name);
}

function analyseProfile(rows: ConversationRow[]) {
	const texts = rows.map((row) => row.user_text);
	const dimensions = [
		tendencyScore(
			texts,
			["我们", "大家", "一起", "聊天", "朋友", "分享"],
			["自己", "独处", "安静", "内心", "一个人", "想一想"],
		),
		tendencyScore(
			texts,
			["具体", "今天", "昨天", "明天", "时间", "事情", "安排"],
			["意义", "未来", "可能", "为什么", "感觉像", "如果"],
		),
		tendencyScore(
			texts,
			["因为", "所以", "逻辑", "解决", "分析", "应该"],
			["感受", "难过", "开心", "关系", "理解", "在乎", "心情"],
		),
		tendencyScore(
			texts,
			["计划", "安排", "必须", "截止", "决定", "完成"],
			["随便", "也许", "再说", "灵活", "看情况", "不确定"],
		),
	];
	const pairs = [
		["E", "I"],
		["S", "N"],
		["T", "F"],
		["J", "P"],
	] as const;
	const mbti = dimensions
		.map((d, index) =>
			d.evidence ? (d.first ? pairs[index]?.[0] : pairs[index]?.[1]) : "X",
		)
		.join("");
	const evidence = dimensions.reduce((sum, item) => sum + item.evidence, 0);
	const confidence = texts.length >= 20 && evidence >= 8 ? "medium" : "low";
	const scores = texts.map(emotionScore);
	const mean = scores.length
		? scores.reduce((a, b) => a + b, 0) / scores.length
		: 0;
	const variance = scores.length
		? scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) /
			scores.length
		: 0;
	const volatility = Math.round(Math.sqrt(variance));
	const daily = new Map<string, number[]>();
	for (const row of rows) {
		const date = row.created_at.slice(0, 10);
		const list = daily.get(date) ?? [];
		list.push(emotionScore(row.user_text));
		daily.set(date, list);
	}
	const emotionTrend: EmotionPoint[] = [...daily.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, dayScores]) => ({
			date,
			score: Math.round(
				dayScores.reduce((a, b) => a + b, 0) / dayScores.length,
			),
			messageCount: dayScores.length,
		}));
	const traits: string[] = [];
	if (dimensions[1]?.first) traits.push("注重具体细节");
	else traits.push("关注可能性与意义");
	if (dimensions[2]?.first) traits.push("倾向分析与解决问题");
	else traits.push("对情绪与关系较敏感");
	if (dimensions[3]?.first) traits.push("偏好结构与确定性");
	else traits.push("保留弹性与选择空间");
	return {
		mbti,
		confidence,
		dimensions: dimensions.map((d, index) => ({
			pair: pairs[index]?.join("") ?? "",
			value: Math.round(50 + (d.first ? 1 : -1) * d.strength * 50),
		})),
		traits,
		topEmotions: topEmotions(texts),
		emotion: {
			average: Math.round(mean),
			volatility,
			level: volatility >= 35 ? "high" : volatility >= 18 ? "medium" : "stable",
			trend: emotionTrend,
		},
	};
}

export function listContactProfiles(
	db: SqliteDb,
	filters: ConversationFilters,
) {
	const where = buildWhere(filters);
	const rows = db
		.prepare(`${BASE_SELECT} ${where.sql} ORDER BY c.created_at ASC LIMIT 2000`)
		.all(...where.values) as ConversationRow[];
	const groups = new Map<string, ConversationRow[]>();
	for (const row of rows) {
		const key = `${row.channel_id}\u0000${row.contact_id}`;
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => {
			const first = group[0];
			const last = group[group.length - 1];
			if (!first || !last) throw new Error("empty profile group");
			return {
				channelId: first.channel_id,
				channelName: first.channel_name,
				wechatAccountId: first.wechat_account_id,
				contactId: first.contact_id,
				contactLabel: maskId(first.contact_id),
				messageCount: group.length,
				firstSeenAt: first.created_at,
				lastSeenAt: last.created_at,
				highRiskCount: group.filter(
					(row) =>
						row.safety_level === "HIGH" || row.safety_level === "IMMINENT",
				).length,
				...analyseProfile(group),
			};
		})
		.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
