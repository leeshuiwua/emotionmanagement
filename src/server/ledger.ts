import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { promptConfig, renderPromptTemplate } from "./core/prompt-config.js";
import { audit, type SqliteDb } from "./db.js";

export const ledgerSchema = `
CREATE TABLE IF NOT EXISTS ledger_books (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS ledger_entries (
 id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES ledger_books(id),
 kind TEXT NOT NULL CHECK(kind IN ('income','expense')), cents INTEGER NOT NULL CHECK(cents > 0),
 category TEXT NOT NULL, account TEXT NOT NULL, note TEXT NOT NULL, date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','posted','cancelled','deleted')),
 source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_book_date ON ledger_entries(book_id, date, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_pending ON ledger_entries(book_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS ledger_receipts (id TEXT PRIMARY KEY);
`;

export function chinaDate() {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
		new Date(),
	);
}
export const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((v) => {
		const d = new Date(`${v}T00:00:00Z`);
		return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
	});
export const entrySchema = z
	.object({
		kind: z.enum(["income", "expense"]),
		amount: z
			.string()
			.regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
			.refine((v) => Number(v) > 0),
		category: z.string().trim().min(1).max(40),
		account: z.string().trim().min(1).max(40),
		note: z.string().trim().max(200).default(""),
		date: dateSchema,
	})
	.strict();
export type EntryInput = z.infer<typeof entrySchema>;
export function amountCents(amount: string) {
	const [whole = "0", fraction = ""] = amount.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function ensureBook(
	db: SqliteDb,
	ownerKey: string,
	name: string,
): string {
	const id = createHash("sha256").update(ownerKey).digest("hex");
	db.prepare(
		"INSERT OR IGNORE INTO ledger_books(id,name,owner_key) VALUES(?,?,?)",
	).run(id, name, ownerKey);
	return id;
}
export function addEntry(
	db: SqliteDb,
	bookId: string,
	input: EntryInput,
	source: string,
	pending = false,
) {
	const v = entrySchema.parse(input);
	const id = randomUUID();
	db.prepare(`INSERT INTO ledger_entries(id,book_id,kind,cents,category,account,note,date,status,source,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
		id,
		bookId,
		v.kind,
		amountCents(v.amount),
		v.category,
		v.account,
		v.note,
		v.date,
		pending ? "pending" : "posted",
		source,
		new Date().toISOString(),
	);
	return id;
}
export function ledgerMonth(db: SqliteDb, bookId: string, month: string) {
	const rows = db
		.prepare(`SELECT kind, SUM(cents) AS cents FROM ledger_entries
 WHERE book_id=? AND substr(date,1,7)=? AND status='posted' GROUP BY kind`)
		.all(bookId, month) as { kind: string; cents: number }[];
	const income = rows.find((r) => r.kind === "income")?.cents ?? 0;
	const expense = rows.find((r) => r.kind === "expense")?.cents ?? 0;
	return { income, expense, net: income - expense };
}

// 只解析显式记账命令；不从普通情绪来信中自动推断财务写操作。
export function parseLedgerText(text: string): EntryInput | null {
	if (
		/[-+负]|昨天|前天|明天|后天|去年|上月|退款|退货|撤销|美元|美金|港币|欧元/.test(
			text,
		)
	)
		return null;
	const match =
		/^(?:记账|记一笔)\s*(?:(收入|支出)\s*)?([^\d\n]{0,40}?)\s*(\d+(?:\.\d{1,2})?)\s*元?\s*$/.exec(
			text,
		);
	if (!match) return null;
	const label = match[2]?.trim() || "未分类";
	const parsed = entrySchema.safeParse({
		kind: match[1] === "收入" ? "income" : "expense",
		amount: match[3],
		category: label,
		account: "默认账户",
		note: label,
		date: chinaDate(),
	});
	return parsed.success ? parsed.data : null;
}

export function handleLedgerMessage(
	db: SqliteDb,
	channelId: string,
	contactId: string,
	text: string,
	messageId: string,
	identifiedEntry?: EntryInput | EntryInput[],
): string | null {
	if (
		!identifiedEntry &&
		!["确认记账", "取消记账", "查账"].includes(text) &&
		!parseLedgerText(text)
	)
		return null;
	return db.transaction(() => {
		const key = JSON.stringify([channelId, contactId, messageId]);
		if (
			!db
				.prepare("INSERT OR IGNORE INTO ledger_receipts(id) VALUES(?)")
				.run(key).changes
		)
			return "";
		const book = ensureBook(
			db,
			JSON.stringify([channelId, contactId]),
			`微信 ${channelId.slice(0, 8)} · ${contactId.slice(0, 6)}…${contactId.slice(-4)}`,
		);
		const pending = db
			.prepare(
				"SELECT id FROM ledger_entries WHERE book_id=? AND status='pending'",
			)
			.get(book) as { id: string } | undefined;
		if (["确认记账", "取消记账"].includes(text)) {
			if (!pending) return promptConfig.ledger.none;
			const status = text === "确认记账" ? "posted" : "cancelled";
			db.prepare("UPDATE ledger_entries SET status=? WHERE id=?").run(
				status,
				pending.id,
			);
			audit(db, {
				actorType: "WECHAT_USER",
				actorId: book,
				action: `LEDGER_${status.toUpperCase()}`,
				resourceType: "LEDGER_ENTRY",
				resourceId: pending.id,
			});
			return status === "posted"
				? promptConfig.ledger.saved
				: promptConfig.ledger.cancelled;
		}
		if (text === "查账") {
			const month = chinaDate().slice(0, 7);
			const totals = ledgerMonth(db, book, month);
			return renderPromptTemplate(promptConfig.ledger.summary, {
				month,
				income: (totals.income / 100).toFixed(2),
				expense: (totals.expense / 100).toFixed(2),
				net: (totals.net / 100).toFixed(2),
			});
		}
		const parsed = identifiedEntry ?? parseLedgerText(text);
		if (!parsed) return promptConfig.ledger.help;
		const inputs = z
			.array(entrySchema)
			.min(1)
			.max(10)
			.parse(Array.isArray(parsed) ? parsed : [parsed]);
		inputs.forEach((input) => {
			const id = addEntry(db, book, input, "wechat");
			audit(db, {
				actorType: "WECHAT_USER",
				actorId: book,
				action: "LEDGER_CREATED",
				resourceType: "LEDGER_ENTRY",
				resourceId: id,
			});
		});
		return promptConfig.ledger.saved;
	})();
}
