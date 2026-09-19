import { createHash, randomUUID } from "node:crypto";
import { promptConfig } from "../core/prompt-config.js";
import type { SqliteDb } from "../db.js";

export type Person = {
	id: string;
	channel_id: string;
	contact_id: string;
	epoch: number;
	revision: number;
};
export type MemoryEvent = {
	id: string;
	person_id: string;
	day: string;
	at: string;
	text: string;
	reply: string;
	intent: string;
	legacy: number;
};
export const beijingDay = (at = new Date()) =>
	new Date(at.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function personFor(
	db: SqliteDb,
	channel: string,
	contact: string,
): Person {
	const id = createHash("sha256")
		.update(JSON.stringify([channel, contact]))
		.digest("hex");
	db.prepare(
		"INSERT OR IGNORE INTO memory_people(id,channel_id,contact_id) VALUES(?,?,?)",
	).run(id, channel, contact);
	return db
		.prepare("SELECT * FROM memory_people WHERE channel_id=? AND contact_id=?")
		.get(channel, contact) as Person;
}
export function queueMemory(db: SqliteDb, id: string, profile = false) {
	db.prepare(`INSERT INTO memory_tasks(person_id,available_at,want_profile) VALUES(?,?,?)
 ON CONFLICT(person_id) DO UPDATE SET want_profile=MAX(want_profile,excluded.want_profile),
 status=CASE WHEN status='running' THEN status ELSE 'pending' END,
 attempts=CASE WHEN status='running' THEN attempts ELSE 0 END,
 available_at=excluded.available_at,error=NULL`).run(
		id,
		new Date().toISOString(),
		Number(profile),
	);
}
export function recordEvent(
	db: SqliteDb,
	person: Person,
	messageId: string,
	text: string,
	reply: string,
	intent: string,
	at = new Date().toISOString(),
	legacy = false,
) {
	const changed = db
		.prepare(`INSERT OR IGNORE INTO memory_events(id,person_id,message_id,day,at,text,reply,intent,legacy)
 VALUES(?,?,?,?,?,?,?,?,?)`)
		.run(
			randomUUID(),
			person.id,
			messageId,
			beijingDay(new Date(at)),
			at,
			text,
			reply,
			intent,
			Number(legacy),
		).changes;
	if (changed) {
		db.prepare("UPDATE memory_people SET revision=revision+1 WHERE id=?").run(
			person.id,
		);
		queueMemory(db, person.id);
	}
}
export function shortMemory(db: SqliteDb, personId: string) {
	const day = beijingDay();
	const events = db
		.prepare(
			"SELECT id,at,text,reply,intent FROM memory_events WHERE person_id=? AND day=? ORDER BY at DESC,rowid DESC LIMIT ?",
		)
		.all(personId, day, promptConfig.memory.recentLimit) as Array<
		Pick<MemoryEvent, "id" | "at" | "text" | "reply" | "intent">
	>;
	return {
		day,
		events: events
			.reverse()
			.map((e) => ({ ...e, text: e.text.slice(0, 2000) })),
		summary:
			(
				db
					.prepare(
						"SELECT summary FROM memory_daily WHERE person_id=? AND day=?",
					)
					.get(personId, day) as { summary: string } | undefined
			)?.summary ?? "",
	};
}
export function backfillMemory(db: SqliteDb) {
	db.transaction(() => {
		const rows = db
			.prepare(`SELECT c.id,m.app_id,m.open_id,c.user_text,c.assistant_text,c.created_at FROM conversations c
 JOIN inbound_messages m ON m.id=c.inbound_message_id
 WHERE NOT EXISTS (SELECT 1 FROM memory_events e JOIN memory_people p ON p.id=e.person_id
 WHERE p.channel_id=m.app_id AND p.contact_id=m.open_id AND e.message_id='history:'||c.id)`)
			.all() as Array<{
			id: string;
			app_id: string;
			open_id: string;
			user_text: string;
			assistant_text: string;
			created_at: string;
		}>;
		for (const row of rows) {
			// New deliveries are already archived under their inbound key.
			const known = db
				.prepare(
					`SELECT 1 FROM memory_events e JOIN memory_people p ON p.id=e.person_id WHERE p.channel_id=? AND p.contact_id=? AND e.at=? AND e.text=?`,
				)
				.get(row.app_id, row.open_id, row.created_at, row.user_text);
			if (!known)
				recordEvent(
					db,
					personFor(db, row.app_id, row.open_id),
					`history:${row.id}`,
					row.user_text,
					row.assistant_text ?? "",
					"insight",
					row.created_at,
					true,
				);
		}
	})();
}
export function clearMemory(db: SqliteDb, personId?: string) {
	const where = personId ? " WHERE person_id=?" : "";
	const args = personId ? [personId] : [];
	for (const table of [
		"memory_tasks",
		"memory_profiles",
		"memory_facts",
		"memory_daily",
		"memory_events",
	])
		db.prepare(`DELETE FROM ${table}${where}`).run(...args);
	db.prepare(
		`UPDATE memory_people SET epoch=epoch+1,revision=revision+1${personId ? " WHERE id=?" : ""}`,
	).run(...args);
}
