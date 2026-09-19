import { Router } from "express";
import { z } from "zod";
import { audit, type SqliteDb } from "../db.js";
import { clearMemory, queueMemory } from "../memory/store.js";
import { memoryView } from "../memory/view.js";
import { requireAdmin } from "./auth.js";

export function createMemoryRouter(db: SqliteDb) {
	const router = Router();
	router.get("/users", requireAdmin(db), (_req, res) => {
		res.json({
			users: db
				.prepare(`SELECT p.id AS personId,p.channel_id AS channelId,p.contact_id AS contactId,
 COALESCE(ch.name,'已删除渠道') AS channelName,COUNT(*) AS messageCount,MIN(e.at) AS firstSeenAt,MAX(e.at) AS lastSeenAt
 FROM memory_people p JOIN memory_events e ON e.person_id=p.id LEFT JOIN im_channels ch ON ch.id=p.channel_id
 GROUP BY p.id ORDER BY lastSeenAt DESC`)
				.all(),
		});
	});
	router.get("/:id", requireAdmin(db), (req, res) => {
		const view = memoryView(db, String(req.params.id));
		if (!view)
			return void res.status(404).json({ error: { message: "记录人不存在" } });
		res.json(view);
	});
	router.post("/:id/refresh", requireAdmin(db, true), (req, res) => {
		const id = String(req.params.id);
		if (!db.prepare("SELECT 1 FROM memory_events WHERE person_id=?").get(id))
			return void res
				.status(404)
				.json({ error: { message: "暂无可整理的记录" } });
		queueMemory(db, id, true);
		res.status(202).json({ queued: true });
	});
	router.post(
		"/:id/facts/:factId/correct",
		requireAdmin(db, true),
		(req, res) => {
			const parsed = z
				.object({ correction: z.string().trim().min(1).max(1000) })
				.strict()
				.safeParse(req.body);
			if (!parsed.success)
				return void res
					.status(400)
					.json({ error: { message: "请填写更正说明（1—1000字）" } });
			const id = String(req.params.id),
				factId = String(req.params.factId);
			const changed = db.transaction(() => {
				const n = db
					.prepare(
						"UPDATE memory_facts SET invalidated_at=?,correction=? WHERE id=? AND person_id=? AND invalidated_at IS NULL",
					)
					.run(
						new Date().toISOString(),
						parsed.data.correction,
						factId,
						id,
					).changes;
				if (!n) return false;
				// Corrections are admin annotations, not fabricated evidence from the subject.
				db.prepare(
					"UPDATE memory_people SET revision=revision+1,epoch=epoch+1 WHERE id=?",
				).run(id);
				db.prepare("DELETE FROM memory_profiles WHERE person_id=?").run(id);
				db.prepare(
					"UPDATE memory_tasks SET status='pending' WHERE person_id=?",
				).run(id);
				queueMemory(db, id, true);
				audit(db, {
					actorType: "ADMIN",
					actorId: req.adminSession?.adminId,
					action: "MEMORY_CORRECTED",
					resourceType: "MEMORY_FACT",
					resourceId: factId,
				});
				return true;
			})();
			res
				.status(changed ? 200 : 404)
				.json(
					changed ? { ok: true } : { error: { message: "记忆不存在或已更正" } },
				);
		},
	);
	router.delete("/:id", requireAdmin(db, true), (req, res) => {
		const id = String(req.params.id);
		if (req.body?.confirmation !== "CLEAR_PERSON_MEMORY")
			return void res
				.status(400)
				.json({ error: { message: "请确认清除选中用户的全部心情和记忆" } });
		const person = db
			.prepare("SELECT channel_id,contact_id FROM memory_people WHERE id=?")
			.get(id) as { channel_id: string; contact_id: string } | undefined;
		if (!person)
			return void res.status(404).json({ error: { message: "记录人不存在" } });
		db.transaction(() => {
			db.prepare(
				"UPDATE inbound_messages SET content=NULL,raw_xml='{}' WHERE app_id=? AND open_id=?",
			).run(person.channel_id, person.contact_id);
			db.prepare(
				"DELETE FROM conversations WHERE inbound_message_id IN (SELECT id FROM inbound_messages WHERE app_id=? AND open_id=?)",
			).run(person.channel_id, person.contact_id);
			db.prepare("DELETE FROM mood_analyses").run();
			clearMemory(db, id);
			audit(db, {
				actorType: "ADMIN",
				actorId: req.adminSession?.adminId,
				action: "PERSON_MEMORY_CLEARED",
				resourceType: "MEMORY_PERSON",
				resourceId: id,
			});
		})();
		res.json({ ok: true });
	});
	return router;
}
