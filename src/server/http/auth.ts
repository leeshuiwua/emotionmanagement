import { randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import {
	type NextFunction,
	type Request,
	type Response,
	Router,
} from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { audit, type SqliteDb } from "../db.js";

export const SESSION_COOKIE = "gxj_session";

function shouldUseSecureCookie(req: Request, config: AppConfig): boolean {
	return config.cookieSecure === "auto" ? req.secure : config.cookieSecure;
}

const LoginSchema = z.object({
	username: z.string().min(3),
	password: z.string().min(8),
});

export type AdminSession = {
	adminId: string;
	username: string;
	csrfToken: string;
};

declare module "express-serve-static-core" {
	interface Request {
		adminSession?: AdminSession;
	}
}

export async function bootstrapAdmin(
	db: SqliteDb,
	config: AppConfig,
): Promise<void> {
	const count = db.prepare("SELECT COUNT(*) AS count FROM admins").get() as {
		count: number;
	};
	if (count.count > 0 || !config.bootstrapAdminPassword) return;
	const now = new Date().toISOString();
	const id = randomUUID();
	const hash = await argon2.hash(config.bootstrapAdminPassword, {
		type: argon2.argon2id,
	});
	db.prepare(
		"INSERT INTO admins(id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	).run(id, config.bootstrapAdminUsername, hash, now, now);
	audit(db, {
		actorType: "SYSTEM",
		action: "ADMIN_BOOTSTRAPPED",
		resourceType: "ADMIN",
		resourceId: id,
	});
}

export function getAdminSession(
	req: Request,
	db: SqliteDb,
): AdminSession | null {
	const sessionId = req.cookies?.[SESSION_COOKIE];
	if (!sessionId) return null;
	const row = db
		.prepare(
			`SELECT s.admin_id AS adminId, a.username, s.csrf_token AS csrfToken
    FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.id = ? AND s.expires_at > ?`,
		)
		.get(sessionId, new Date().toISOString()) as AdminSession | undefined;
	return row ?? null;
}

/** 鉴权中间件：可选校验 CSRF */
export function requireAdmin(db: SqliteDb, csrf = false) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const session = getAdminSession(req, db);
		if (!session) {
			res
				.status(401)
				.json({ error: { code: "UNAUTHORIZED", message: "请先登录" } });
			return;
		}
		if (csrf && req.headers["x-csrf-token"] !== session.csrfToken) {
			res.status(403).json({
				error: {
					code: "CSRF_INVALID",
					message: "安全校验失败，请刷新后重试",
				},
			});
			return;
		}
		req.adminSession = session;
		next();
	};
}

const loginLimiter = rateLimit({
	windowMs: 60_000,
	max: 8,
	standardHeaders: true,
	legacyHeaders: false,
	skip: (req) => req.app.get("env") === "test",
	message: {
		error: { code: "RATE_LIMITED", message: "尝试过于频繁，请稍后再试" },
	},
});

export function createAuthRouter(db: SqliteDb, config: AppConfig): Router {
	const router = Router();

	router.post("/login", loginLimiter, async (req, res) => {
		const parsed = LoginSchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({
				error: { code: "INVALID_INPUT", message: "请输入有效的账号和密码" },
			});
			return;
		}
		const admin = db
			.prepare(
				"SELECT id, username, password_hash AS passwordHash FROM admins WHERE username = ?",
			)
			.get(parsed.data.username) as
			| { id: string; username: string; passwordHash: string }
			| undefined;
		if (
			!admin ||
			!(await argon2.verify(admin.passwordHash, parsed.data.password))
		) {
			audit(db, {
				actorType: "ADMIN",
				action: "LOGIN_FAILED",
				resourceType: "SESSION",
				detail: { username: parsed.data.username },
			});
			res
				.status(401)
				.json({ error: { code: "LOGIN_FAILED", message: "账号或密码错误" } });
			return;
		}
		const id = randomBytes(32).toString("base64url");
		const csrfToken = randomBytes(24).toString("base64url");
		const now = new Date();
		const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
		db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(
			now.toISOString(),
		);
		db.prepare(
			"INSERT INTO admin_sessions(id, admin_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(id, admin.id, csrfToken, expires.toISOString(), now.toISOString());
		const secure = shouldUseSecureCookie(req, config);
		res.cookie(SESSION_COOKIE, id, {
			httpOnly: true,
			secure,
			sameSite: "strict",
			path: "/",
			expires,
		});
		audit(db, {
			actorType: "ADMIN",
			actorId: admin.id,
			action: "LOGIN_SUCCEEDED",
			resourceType: "SESSION",
		});
		res.json({ user: { username: admin.username }, csrfToken });
	});

	router.get("/session", requireAdmin(db), (req, res) => {
		res.json({
			user: { username: req.adminSession?.username },
			csrfToken: req.adminSession?.csrfToken,
		});
	});

	router.post("/logout", requireAdmin(db, true), (req, res) => {
		const id = req.cookies?.[SESSION_COOKIE];
		if (id) db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(id);
		res.clearCookie(SESSION_COOKIE, {
			httpOnly: true,
			secure: shouldUseSecureCookie(req, config),
			sameSite: "strict",
			path: "/",
		});
		res.status(204).end();
	});

	return router;
}
