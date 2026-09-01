import { Router } from "express";
import type { SqliteDb } from "../db.js";
import { requireAdmin } from "./auth.js";

export function createSystemRouter(db: SqliteDb): Router {
	const router = Router();

	router.get("/system/status", requireAdmin(db), (_req, res) => {
		const settingRows = db
			.prepare(
				`SELECT kind, COALESCE(role, '') AS role, status, tested_at AS testedAt, activated_at AS activatedAt
      FROM setting_versions WHERE status IN ('ACTIVE','TESTED') ORDER BY created_at DESC`,
			)
			.all();
		const metrics = db
			.prepare(
				`SELECT
      (SELECT COUNT(*) FROM wechat_users WHERE subscribed = 1) AS users,
      (SELECT COUNT(*) FROM conversations WHERE created_at >= datetime('now', '-7 days')) AS conversations7d,
      (SELECT COUNT(*) FROM im_channels WHERE enabled = 1) AS activeChannels`,
			)
			.get();
		res.json({
			service: "healthy",
			database: "connected",
			settings: settingRows,
			metrics,
			checkedAt: new Date().toISOString(),
		});
	});

	router.get("/audit-events", requireAdmin(db), (req, res) => {
		const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
		res.json(
			db
				.prepare(
					`SELECT id, actor_type AS actorType, actor_id AS actorId, action, resource_type AS resourceType,
      resource_id AS resourceId, detail_json AS detail, created_at AS createdAt FROM audit_events ORDER BY created_at DESC LIMIT ?`,
				)
				.all(limit),
		);
	});

	return router;
}
