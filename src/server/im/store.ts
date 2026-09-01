// IM 渠道数据访问：仅支持 wechat（个人微信号 ilink bot 协议）。
// 扫码登录后由服务端将凭据写入 config（token/baseUrl/userId/botId）。
import { nowIso, type SqliteDb, uid } from "../db.js";

export const CHANNEL_TYPES = ["wechat"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type WechatChannelConfig = {
	token?: string;
	baseUrl?: string;
	userId?: string;
	botId?: string;
};

export type ImChannel = {
	id: string;
	type: ChannelType;
	name: string;
	enabled: boolean;
	config: WechatChannelConfig;
	cursor: string | null;
	created_at: string;
	updated_at: string;
};

type ImChannelRow = {
	id: string;
	type: string;
	name: string;
	enabled: number;
	config: string;
	cursor: string | null;
	created_at: string;
	updated_at: string;
};

const CONFIG_FIELDS: Array<keyof WechatChannelConfig> = [
	"token",
	"baseUrl",
	"userId",
	"botId",
];

export function normalizeConfig(
	raw: Partial<WechatChannelConfig> = {},
): WechatChannelConfig {
	const out: WechatChannelConfig = {};
	for (const f of CONFIG_FIELDS) {
		const v = raw[f];
		if (typeof v === "string") out[f] = v.trim();
	}
	return out;
}

// 凭据类校验只在渠道被启用时强制（个人微信号先建渠道、再扫码获取 token）
export function validateConfig(
	config: WechatChannelConfig,
	opts: { enabled?: boolean } = {},
): string | null {
	if (!opts.enabled) return null;
	if (!config.token) return "wechat bot token required (scan QR to login)";
	return null;
}

function rowToChannel(row: ImChannelRow): ImChannel {
	let config: WechatChannelConfig = {};
	try {
		config = JSON.parse(row.config || "{}") as WechatChannelConfig;
	} catch {
		config = {};
	}
	return {
		id: row.id,
		type: row.type as ChannelType,
		name: row.name,
		enabled: row.enabled !== 0,
		config,
		cursor: row.cursor,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export function listChannels(db: SqliteDb): ImChannel[] {
	return db
		.prepare("SELECT * FROM im_channels ORDER BY created_at")
		.all()
		.map((r) => rowToChannel(r as ImChannelRow));
}

export function getChannel(db: SqliteDb, id: string): ImChannel | null {
	const row = db.prepare("SELECT * FROM im_channels WHERE id=?").get(id) as
		| ImChannelRow
		| undefined;
	return row ? rowToChannel(row) : null;
}

export type CreateChannelInput = {
	type: ChannelType;
	name?: string;
	enabled?: boolean;
	config?: WechatChannelConfig;
};

export function createChannel(
	db: SqliteDb,
	input: CreateChannelInput,
): ImChannel {
	const norm = normalizeConfig(input.config);
	const err = validateConfig(norm, { enabled: input.enabled });
	if (err) throw new Error(err);
	const id = uid();
	const now = nowIso();
	const name = (input.name || "我的微信").slice(0, 60);
	db.prepare(
		"INSERT INTO im_channels(id,type,name,enabled,config,cursor,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?)",
	).run(
		id,
		input.type,
		name,
		input.enabled ? 1 : 0,
		JSON.stringify(norm),
		now,
		now,
	);
	const created = getChannel(db, id);
	if (!created) throw new Error("channel was not persisted");
	return created;
}

export type UpdateChannelInput = {
	name?: string;
	enabled?: boolean;
	config?: WechatChannelConfig;
};

export function updateChannel(
	db: SqliteDb,
	id: string,
	patch: UpdateChannelInput,
): ImChannel | null {
	const ch = getChannel(db, id);
	if (!ch) return null;
	const name =
		typeof patch.name === "string" && patch.name.trim()
			? patch.name.trim().slice(0, 60)
			: ch.name;
	const enabled =
		typeof patch.enabled === "boolean" ? patch.enabled : ch.enabled;
	const config = normalizeConfig({ ...ch.config, ...(patch.config || {}) });
	const err = validateConfig(config, { enabled });
	if (err) throw new Error(err);
	db.prepare(
		"UPDATE im_channels SET name=?, enabled=?, config=?, updated_at=? WHERE id=?",
	).run(name, enabled ? 1 : 0, JSON.stringify(config), nowIso(), id);
	return getChannel(db, id);
}

export function deleteChannel(db: SqliteDb, id: string): void {
	db.prepare("DELETE FROM im_channels WHERE id=?").run(id);
}

export function setCursor(
	db: SqliteDb,
	id: string,
	cursor: string | null,
): void {
	db.prepare("UPDATE im_channels SET cursor=? WHERE id=?").run(
		cursor == null ? null : String(cursor),
		id,
	);
}
