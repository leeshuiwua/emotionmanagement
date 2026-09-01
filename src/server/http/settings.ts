import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { audit, type SqliteDb } from "../db.js";
import {
	decryptSecret,
	encryptSecret,
	maskSecret,
} from "../security/crypto.js";
import { requireAdmin } from "./auth.js";

const SettingSchema = z.object({
	config: z.record(z.string(), z.unknown()),
	secret: z.string().min(1).optional(),
	secrets: z.record(z.string(), z.string().min(1)).optional(),
});
const ModelRoleSchema = z.enum(["regular", "safety"]);

type SettingRow = {
	id: string;
	kind: string;
	role: string | null;
	status: string;
	config_json: string;
	encrypted_secret: string | null;
	test_message: string | null;
	created_at: string;
	tested_at: string | null;
	activated_at: string | null;
};

type SettingView = {
	id: string;
	kind: string;
	role: string | null;
	status: string;
	config: unknown;
	secretMasked: string | null;
	secretFields: Record<string, string> | null;
	hasSecret: boolean;
	testMessage: string | null;
	createdAt: string;
	testedAt: string | null;
	activatedAt: string | null;
};

function view(row: SettingRow, key: Buffer): SettingView {
	const secretPayload = row.encrypted_secret
		? decryptSecret(row.encrypted_secret, key)
		: null;
	let secrets: Record<string, string> | null = null;
	if (secretPayload?.startsWith("{")) {
		try {
			secrets = JSON.parse(secretPayload) as Record<string, string>;
		} catch {
			secrets = null;
		}
	}
	return {
		id: row.id,
		kind: row.kind,
		role: row.role,
		status: row.status,
		config: JSON.parse(row.config_json),
		secretMasked: secrets ? null : maskSecret(secretPayload),
		secretFields: secrets
			? (Object.fromEntries(
					Object.entries(secrets).map(([name, value]) => [
						name,
						maskSecret(value) ?? "••••••••",
					]),
				) as Record<string, string>)
			: null,
		hasSecret: Boolean(secretPayload),
		testMessage: row.test_message,
		createdAt: row.created_at,
		testedAt: row.tested_at,
		activatedAt: row.activated_at,
	};
}

function latest(
	db: SqliteDb,
	kind: string,
	role: string | null,
): SettingRow | undefined {
	return db
		.prepare(
			`SELECT * FROM setting_versions WHERE kind = ? AND COALESCE(role, '') = COALESCE(?, '')
    ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
		)
		.get(kind, role) as SettingRow | undefined;
}

function registerKind(
	router: Router,
	db: SqliteDb,
	config: AppConfig,
	kind: "model",
	role: string,
	prefix: string,
): void {
	router.get(prefix, requireAdmin(db), (_req, res) => {
		const row = latest(db, kind, role);
		res.json(row ? view(row, config.masterKey) : null);
	});

	router.post(prefix, requireAdmin(db, true), (req, res) => {
		const parsed = SettingSchema.safeParse(req.body);
		if (!parsed.success) {
			res
				.status(400)
				.json({ error: { code: "INVALID_INPUT", message: "配置格式不正确" } });
			return;
		}
		const id = randomUUID();
		const now = new Date().toISOString();
		const previous = latest(db, kind, role);
		const secretPayload = parsed.data.secrets
			? JSON.stringify(parsed.data.secrets)
			: parsed.data.secret;
		const encrypted = secretPayload
			? encryptSecret(secretPayload, config.masterKey)
			: (previous?.encrypted_secret ?? null);
		db.prepare(
			`INSERT INTO setting_versions
      (id, kind, role, status, config_json, encrypted_secret, created_by, created_at)
      VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
		).run(
			id,
			kind,
			role,
			JSON.stringify(parsed.data.config),
			encrypted,
			req.adminSession?.adminId,
			now,
		);
		audit(db, {
			actorType: "ADMIN",
			actorId: req.adminSession?.adminId,
			action: "SETTING_DRAFTED",
			resourceType: kind.toUpperCase(),
			resourceId: id,
			detail: { role },
		});
		const created = latest(db, kind, role);
		if (!created) throw new Error("Draft was not persisted");
		res.status(201).json(view(created, config.masterKey));
	});

	router.post(`${prefix}/test`, requireAdmin(db, true), (req, res) => {
		const row = latest(db, kind, role);
		if (row?.status !== "DRAFT") {
			res
				.status(409)
				.json({ error: { code: "NO_DRAFT", message: "请先保存草稿" } });
			return;
		}
		const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
		let ok = true;
		let message = "配置完整性校验通过";
		if (kind === "model")
			ok = Boolean(cfg.baseUrl && cfg.model && row.encrypted_secret);
		if (!ok) message = "缺少必填配置或密钥";
		if (!ok) {
			res.status(422).json({ ok, message });
			return;
		}
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE setting_versions SET status = 'TESTED', test_message = ?, tested_at = ? WHERE id = ?",
		).run(message, now, row.id);
		audit(db, {
			actorType: "ADMIN",
			actorId: req.adminSession?.adminId,
			action: "SETTING_TESTED",
			resourceType: kind.toUpperCase(),
			resourceId: row.id,
			detail: { role },
		});
		res.json({ ok, message });
	});

	router.post(`${prefix}/activate`, requireAdmin(db, true), (req, res) => {
		const row = latest(db, kind, role);
		if (row?.status !== "TESTED") {
			res.status(409).json({
				error: {
					code: "NOT_TESTED",
					message: "只有测试通过的配置才能启用",
				},
			});
			return;
		}
		const now = new Date().toISOString();
		db.transaction(() => {
			db.prepare(
				"UPDATE setting_versions SET status = 'RETIRED' WHERE kind = ? AND COALESCE(role, '') = COALESCE(?, '') AND status = 'ACTIVE'",
			).run(kind, role);
			db.prepare(
				"UPDATE setting_versions SET status = 'ACTIVE', activated_at = ? WHERE id = ?",
			).run(now, row.id);
		})();
		audit(db, {
			actorType: "ADMIN",
			actorId: req.adminSession?.adminId,
			action: "SETTING_ACTIVATED",
			resourceType: kind.toUpperCase(),
			resourceId: row.id,
			detail: { role },
		});
		res.json(
			view({ ...row, status: "ACTIVE", activated_at: now }, config.masterKey),
		);
	});
}

export function createSettingsRouter(db: SqliteDb, config: AppConfig): Router {
	const router = Router();
	for (const role of ModelRoleSchema.options)
		registerKind(router, db, config, "model", role, `/settings/models/${role}`);
	return router;
}

export function activeSetting(
	db: SqliteDb,
	config: AppConfig,
	kind: string,
	role: string | null,
) {
	const row = db
		.prepare(
			"SELECT * FROM setting_versions WHERE kind = ? AND COALESCE(role, '') = COALESCE(?, '') AND status = 'ACTIVE' LIMIT 1",
		)
		.get(kind, role) as SettingRow | undefined;
	if (!row) return null;
	const payload = row.encrypted_secret
		? decryptSecret(row.encrypted_secret, config.masterKey)
		: null;
	let secrets: Record<string, string> | null = null;
	if (payload?.startsWith("{")) {
		try {
			secrets = JSON.parse(payload) as Record<string, string>;
		} catch {
			secrets = null;
		}
	}
	return {
		id: row.id,
		config: JSON.parse(row.config_json) as Record<string, unknown>,
		secret: secrets ? null : payload,
		secrets,
	};
}
