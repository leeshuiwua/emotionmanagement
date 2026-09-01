import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookieParser from "cookie-parser";
import express, {
	type Application,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { openDatabase, type SqliteDb } from "./db.js";
import { bootstrapAdmin, createAuthRouter } from "./http/auth.js";
import { createImRouter } from "./http/im.js";
import { createSettingsRouter } from "./http/settings.js";
import { createSystemRouter } from "./http/system.js";
import { stopAll, syncChannels } from "./im/index.js";

export async function createApp(
	config: AppConfig,
	database?: SqliteDb,
): Promise<{ app: Application; db: SqliteDb; close: () => void }> {
	const db = database ?? openDatabase(config.databasePath);
	await bootstrapAdmin(db, config);

	const app = express();
	app.disable("x-powered-by");
	app.set("env", config.env);
	app.use(helmet({ contentSecurityPolicy: false }));
	app.use(express.json({ limit: "256kb" }));
	app.use(cookieParser());

	// 健康检查（无鉴权，供探活使用）
	app.get("/healthz", (_req: Request, res: Response) => {
		res.json({ status: "ok", time: new Date().toISOString() });
	});

	// 业务路由统一前缀 /admin-api/v1
	app.use("/admin-api/v1/auth", createAuthRouter(db, config));
	app.use(
		"/admin-api/v1",
		createSettingsRouter(db, config),
		createSystemRouter(db),
	);
	app.use("/admin-api/v1/im", createImRouter(db, config));

	// 静态资源（生产构建产物）
	const webRoot = resolve("dist/web");
	if (existsSync(webRoot)) {
		app.use("/admin", express.static(webRoot));
		app.get("/admin", (_req: Request, res: Response) =>
			res.redirect("/admin/"),
		);
		// SPA fallback：仅对 /admin/* 下未命中的资源回退到 index.html
		app.use("/admin", (req: Request, res: Response, next: NextFunction) => {
			if (req.method !== "GET") return next();
			res.sendFile(resolve(webRoot, "index.html"), (err) => {
				if (err) next(err);
			});
		});
	}

	// 统一错误处理：404 与抛错
	app.use((_req: Request, res: Response) => {
		res
			.status(404)
			.json({ error: { code: "NOT_FOUND", message: "Not found" } });
	});
	app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		const message = err instanceof Error ? err.message : "Internal error";
		res.status(500).json({ error: { code: "INTERNAL", message } });
	});

	// 启动时按 DB 配置拉起 IM 渠道
	try {
		syncChannels(db, config);
	} catch (e) {
		console.error("[im] syncChannels failed on startup:", e);
	}

	const close = () => {
		stopAll();
		db.close();
	};

	return { app, db, close };
}
