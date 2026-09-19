import type { SqliteDb } from "../db.js";
import { type MemoryProfile, promptHash } from "./agent.js";
import { shortMemory } from "./store.js";

export function memoryView(db: SqliteDb, personId: string) {
	const person = db
		.prepare(
			"SELECT id,channel_id,contact_id,revision FROM memory_people WHERE id=?",
		)
		.get(personId) as
		| { id: string; channel_id: string; contact_id: string; revision: number }
		| undefined;
	if (!person) return null;
	const row = db
		.prepare(
			"SELECT * FROM memory_profiles WHERE person_id=? ORDER BY rowid DESC LIMIT 1",
		)
		.get(personId) as
		| {
				id: string;
				revision: number;
				model: string;
				prompt_hash: string;
				created_at: string;
				result_json: string;
		  }
		| undefined;
	const facts = db
		.prepare(
			"SELECT id,kind,text,evidence_json,created_at,correction,invalidated_at FROM memory_facts WHERE person_id=? ORDER BY rowid DESC LIMIT 100",
		)
		.all(personId) as Array<{
		id: string;
		kind: string;
		text: string;
		evidence_json: string;
		created_at: string;
		correction: string | null;
		invalidated_at: string | null;
	}>;
	const profile = row
		? {
				id: row.id,
				revision: row.revision,
				model: row.model,
				createdAt: row.created_at,
				analysis: JSON.parse(row.result_json) as MemoryProfile,
			}
		: null;
	const evidenceIds = new Set([
		...facts.flatMap((f) => JSON.parse(f.evidence_json) as string[]),
		...(profile?.analysis.traits.flatMap((t) => t.evidenceIds) ?? []),
	]);
	const evidence = [...evidenceIds]
		.map(
			(id) =>
				db
					.prepare(
						"SELECT id,at,text,legacy FROM memory_events WHERE person_id=? AND id=?",
					)
					.get(personId, id) as
					| { id: string; at: string; text: string; legacy: number }
					| undefined,
		)
		.filter((e): e is NonNullable<typeof e> => Boolean(e));
	const counts = db
		.prepare(
			"SELECT count(*) AS messages,count(DISTINCT day) AS days,MIN(at) AS firstAt,MAX(at) AS lastAt,SUM(processed=0) AS pending FROM memory_events WHERE person_id=?",
		)
		.get(personId) as {
		messages: number;
		days: number;
		firstAt: string | null;
		lastAt: string | null;
		pending: number | null;
	};
	const totalFacts = (
		db
			.prepare(
				"SELECT count(*) AS n FROM memory_facts WHERE person_id=? AND invalidated_at IS NULL",
			)
			.get(personId) as { n: number }
	).n;
	const task = db
		.prepare("SELECT status,error FROM memory_tasks WHERE person_id=?")
		.get(personId) as { status: string; error: string | null } | undefined;
	return {
		person,
		counts,
		totalFacts,
		shortTerm: shortMemory(db, personId),
		facts: facts.map((f) => ({
			id: f.id,
			kind: f.kind,
			text: f.text,
			createdAt: f.created_at,
			evidenceIds: JSON.parse(f.evidence_json) as string[],
			invalidatedAt: f.invalidated_at,
			correction: f.correction,
		})),
		profile,
		evidence,
		stale:
			!profile ||
			profile.revision !== person.revision ||
			row?.prompt_hash !== promptHash(),
		task: task ?? null,
	};
}
export type MemoryView = NonNullable<ReturnType<typeof memoryView>>;
