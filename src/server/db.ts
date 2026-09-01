import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type SqliteDb = Database.Database;

// 数据库 schema：
// - admins / admin_sessions：管理员与登录会话
// - setting_versions：仅保留 model（日常+安全两个 role）
// - im_channels：IM 渠道（个人微信 ilink bot），扫码登录凭据写入 config
// - wechat_users / inbound_messages / conversations：业务流水
// - audit_events：审计
// 旧的 jobs/channel_runtime/wechat_personal_sessions/wechat_qr_sessions 表
// 已随 Wechaty 方案移除，迁移时 DROP IF EXISTS 清理旧库。
const MIGRATIONS = `
DROP TABLE IF EXISTS wechat_qr_sessions;
DROP TABLE IF EXISTS wechat_personal_sessions;
DROP TABLE IF EXISTS channel_runtime;
DROP TABLE IF EXISTS jobs;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS setting_versions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','TESTED','ACTIVE','RETIRED')),
  config_json TEXT NOT NULL,
  encrypted_secret TEXT,
  test_message TEXT,
  created_by TEXT REFERENCES admins(id),
  created_at TEXT NOT NULL,
  tested_at TEXT,
  activated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_setting
  ON setting_versions(kind, COALESCE(role, '')) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS im_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wechat_users (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  subscribed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, open_id)
);
CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT,
  raw_xml TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES wechat_users(id),
  inbound_message_id TEXT NOT NULL REFERENCES inbound_messages(id),
  user_text TEXT NOT NULL,
  safety_level TEXT NOT NULL,
  assistant_text TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbound_channel_contact_time
  ON inbound_messages(app_id, open_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created
  ON conversations(created_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
`;

export function openDatabase(path: string): SqliteDb {
	if (path !== ":memory:")
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.exec(MIGRATIONS);
	db.prepare(
		"INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)",
	).run(new Date().toISOString());
	return db;
}

export function uid(): string {
	return randomUUID();
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function audit(
	db: SqliteDb,
	event: {
		actorType: string;
		actorId?: string;
		action: string;
		resourceType: string;
		resourceId?: string;
		detail?: unknown;
	},
): void {
	db.prepare(`INSERT INTO audit_events
    (id, actor_type, actor_id, action, resource_type, resource_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
		randomUUID(),
		event.actorType,
		event.actorId ?? null,
		event.action,
		event.resourceType,
		event.resourceId ?? null,
		JSON.stringify(event.detail ?? {}),
		new Date().toISOString(),
	);
}
