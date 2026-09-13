import { Router } from "express";
import { z } from "zod";
import { audit, type SqliteDb } from "../db.js";
import { addEntry, ensureBook, entrySchema, ledgerMonth } from "../ledger.js";
import { requireAdmin } from "./auth.js";

export function createLedgerRouter(db: SqliteDb) {
	const router = Router();
	router.use(requireAdmin(db, false));
	router.use((req, res, next) => {
		if (req.method === "GET") return next();
		return requireAdmin(db, true)(req, res, next);
	});
	router.get("/books", (_req, res) => {
		ensureBook(db, "admin", "我的账本");
		res.json({
			books: db
				.prepare("SELECT id,name FROM ledger_books ORDER BY name,id")
				.all(),
		});
	});
	router.use("/books/:bookId", (req, res, next) => {
		if (
			!db
				.prepare("SELECT id FROM ledger_books WHERE id=?")
				.get(String(req.params.bookId))
		) {
			res.status(404).json({ error: { message: "账本不存在" } });
			return;
		}
		next();
	});
	router.get("/books/:bookId/entries", (req, res) => {
		const query = z
			.object({
				month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
				page: z.coerce.number().int().min(1).max(100000).default(1),
			})
			.safeParse(req.query);
		if (!query.success)
			return void res
				.status(400)
				.json({ error: { message: "月份或页码不正确" } });
		const { month, page } = query.data;
		const bookId = String(req.params.bookId);
		const where = "book_id=? AND substr(date,1,7)=? AND status='posted'";
		const { total } = db
			.prepare(`SELECT COUNT(*) AS total FROM ledger_entries WHERE ${where}`)
			.get(bookId, month) as { total: number };
		res.json({
			items: db
				.prepare(
					`SELECT id,kind,cents,category,account,note,date,source FROM ledger_entries WHERE ${where} ORDER BY date DESC,created_at DESC,id DESC LIMIT 30 OFFSET ?`,
				)
				.all(bookId, month, (page - 1) * 30),
			total,
			page,
			summary: ledgerMonth(db, bookId, month),
			categories: db
				.prepare(
					`SELECT category,SUM(cents) AS cents FROM ledger_entries WHERE ${where} AND kind='expense' GROUP BY category ORDER BY cents DESC`,
				)
				.all(bookId, month),
		});
	});
	router.post("/books/:bookId/entries", (req, res) => {
		const parsed = entrySchema.safeParse(req.body);
		if (!parsed.success)
			return void res.status(400).json({
				error: { message: "请检查金额（最多两位小数）、日期、分类和账户" },
			});
		const id = db.transaction(() => {
			const id = addEntry(db, String(req.params.bookId), parsed.data, "web");
			audit(db, {
				actorType: "ADMIN",
				actorId: req.adminSession?.adminId,
				action: "LEDGER_CREATED",
				resourceType: "LEDGER_ENTRY",
				resourceId: id,
			});
			return id;
		})();
		res.status(201).json({ id });
	});
	router.delete("/books/:bookId/entries/:id", (req, res) => {
		const changed = db.transaction(() => {
			const changed = db
				.prepare(
					"UPDATE ledger_entries SET status='deleted' WHERE book_id=? AND id=? AND status='posted'",
				)
				.run(String(req.params.bookId), String(req.params.id)).changes;
			if (changed)
				audit(db, {
					actorType: "ADMIN",
					actorId: req.adminSession?.adminId,
					action: "LEDGER_DELETED",
					resourceType: "LEDGER_ENTRY",
					resourceId: String(req.params.id),
				});
			return changed;
		})();
		if (!changed)
			return void res.status(404).json({ error: { message: "账目不存在" } });
		res.status(204).end();
	});
	return router;
}
