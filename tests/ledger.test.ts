import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import {
	addEntry,
	amountCents,
	chinaDate,
	ensureBook,
	entrySchema,
	handleLedgerMessage,
	ledgerMonth,
	parseLedgerText,
} from "../src/server/ledger.js";

const databases: ReturnType<typeof openDatabase>[] = [];
const boot = () => {
	const db = openDatabase(":memory:");
	databases.push(db);
	return db;
};
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

describe("ledger", () => {
	it("uses integer cents and validates impossible dates and invalid amounts", () => {
		expect(amountCents("0.29")).toBe(29);
		expect(amountCents("35.1")).toBe(3510);
		for (const text of [
			"记账 午饭-35元",
			"记账 午饭0元",
			"记账 昨天午饭35元",
			"记账 退款35元",
			"记账 午饭35美元",
			"记账 午饭1.234元",
			"今天花了35元很难过",
		])
			expect(parseLedgerText(text)).toBeNull();
		expect(
			entrySchema.safeParse({
				kind: "expense",
				amount: "1",
				account: "现金",
				category: "餐饮",
				note: "",
				date: "2026-02-30",
			}).success,
		).toBe(false);
	});
	it("posts automatically, survives repeated processing and isolates contacts and channels", () => {
		const db = boot();
		const reply = handleLedgerMessage(
			db,
			"channel",
			"alice",
			"记账 午饭35元",
			"m1",
		);
		expect(reply).toContain("已记账");
		const book = ensureBook(db, JSON.stringify(["channel", "alice"]), "Alice");
		const month = chinaDate().slice(0, 7);
		expect(ledgerMonth(db, book, month).expense).toBe(3500);
		expect(
			handleLedgerMessage(db, "channel", "bob", "确认记账", "m2"),
		).toContain("没有待确认");
		expect(
			handleLedgerMessage(db, "other", "alice", "确认记账", "m2"),
		).toContain("没有待确认");
		expect(
			handleLedgerMessage(db, "channel", "alice", "记账 午饭35元", "m1"),
		).toBe("");
		expect(
			handleLedgerMessage(db, "channel", "alice", "确认记账", "m3"),
		).toContain("没有待确认");
		expect(handleLedgerMessage(db, "channel", "alice", "确认记账", "m3")).toBe(
			"",
		);
		expect(ledgerMonth(db, book, month).expense).toBe(3500);
		expect(handleLedgerMessage(db, "channel", "alice", "查账", "m4")).toContain(
			"35.00",
		);
	});
	it("preserves legacy drafts without blocking new automatic entries", () => {
		const db = boot();
		const book = ensureBook(db, JSON.stringify(["c", "a"]), "A");
		const draft = parseLedgerText("记账 收入 工资8000元");
		if (!draft) throw new Error("draft missing");
		addEntry(db, book, draft, "wechat", true);
		expect(handleLedgerMessage(db, "c", "a", "记账 午饭35元", "2")).toContain(
			"已记账",
		);
		expect(handleLedgerMessage(db, "c", "a", "取消记账", "3")).toContain(
			"已取消",
		);
		expect(ledgerMonth(db, book, chinaDate().slice(0, 7)).expense).toBe(3500);
		expect(ledgerMonth(db, book, chinaDate().slice(0, 7)).income).toBe(0);
		expect(handleLedgerMessage(db, "c", "a", "今天心情不好", "5")).toBeNull();
	});
	it("summarizes only the selected month and book", () => {
		const db = boot();
		const book = ensureBook(db, "admin", "本地");
		addEntry(
			db,
			book,
			{
				kind: "income",
				amount: "100",
				category: "工资",
				account: "现金",
				note: "",
				date: "2026-09-01",
			},
			"web",
		);
		addEntry(
			db,
			book,
			{
				kind: "expense",
				amount: "0.29",
				category: "餐饮",
				account: "现金",
				note: "",
				date: "2026-09-01",
			},
			"web",
		);
		addEntry(
			db,
			book,
			{
				kind: "expense",
				amount: "50",
				category: "餐饮",
				account: "现金",
				note: "",
				date: "2026-08-01",
			},
			"web",
		);
		expect(ledgerMonth(db, book, "2026-09")).toEqual({
			income: 10000,
			expense: 29,
			net: 9971,
		});
	});
});
