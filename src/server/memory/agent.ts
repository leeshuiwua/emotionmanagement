import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { loggedModelFetch } from "../core/model-log.js";
import { promptConfig } from "../core/prompt-config.js";
import type { SqliteDb } from "../db.js";
import { activeSetting } from "../http/settings.js";
import type { MemoryEvent, Person } from "./store.js";

const text = z.string().trim().min(1).max(2000);
const ids = z.array(z.string().min(1)).min(1).max(10);
const extraction = z
	.object({
		summary: text,
		memories: z
			.array(
				z
					.object({
						kind: z.enum(["fact", "preference", "pattern", "coping"]),
						text,
						evidenceIds: ids,
					})
					.strict(),
			)
			.max(20),
	})
	.strict();
export const profileSchema = z
	.object({
		overview: text,
		traits: z
			.array(
				z
					.object({
						title: text,
						observation: text,
						counterEvidence: text,
						evidenceIds: ids,
					})
					.strict(),
			)
			.max(6),
		changes: text,
		limitations: text,
	})
	.strict();
export type MemoryProfile = z.infer<typeof profileSchema>;
export const promptHash = () =>
	createHash("sha256")
		.update(JSON.stringify(promptConfig.memory))
		.digest("hex");
type Fact = {
	id: string;
	kind: string;
	text: string;
	evidence_json: string;
	created_at: string;
};

async function ask(
	config: AppConfig,
	model: NonNullable<ReturnType<typeof activeSetting>>,
	workload: "memory" | "profile",
	system: string,
	payload: unknown,
) {
	const name = String(model.config.model);
	if (!model.secret) throw new Error("model_not_configured");
	const response = await loggedModelFetch(
		config,
		workload,
		name,
		model.secret,
		`${String(model.config.baseUrl).replace(/\/$/, "")}/chat/completions`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${model.secret}`,
			},
			body: JSON.stringify({
				model: name,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: JSON.stringify(payload) },
				],
				response_format: { type: "json_object" },
				max_tokens: promptConfig.memory.maxTokens,
				...(/^deepseek-(?:flash|v4-(?:flash|pro))$/.test(name)
					? { thinking: { type: "disabled" } }
					: {}),
			}),
			signal: AbortSignal.timeout(promptConfig.memory.requestTimeoutMs),
		},
	);
	if (!response.ok) throw new Error(`http_${response.status}`);
	const body = (await response.json()) as {
		choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
	};
	const choice = body.choices?.[0];
	if (choice?.finish_reason === "length" || !choice?.message?.content)
		throw new Error("invalid_output");
	return JSON.parse(
		choice.message.content
			.trim()
			.replace(/^```(?:json)?\s*([\s\S]*?)```$/, "$1"),
	);
}
function alive(db: SqliteDb, person: Person, revision?: number) {
	if (!db.open) return false;
	const current = db
		.prepare("SELECT epoch,revision FROM memory_people WHERE id=?")
		.get(person.id) as Person | undefined;
	return (
		current?.epoch === person.epoch &&
		(revision === undefined || current.revision === revision)
	);
}
/** One bounded extraction batch. Jobs persist; a crash only replays an uncommitted batch. */
export async function processMemoryTask(
	db: SqliteDb,
	config: AppConfig,
	person: Person,
	wantProfile: boolean,
) {
	const model = activeSetting(db, config, "model", "regular");
	if (!model?.secret) throw new Error("model_not_configured");
	const next = db
		.prepare(
			"SELECT day FROM memory_events WHERE person_id=? AND processed=0 ORDER BY at,rowid LIMIT 1",
		)
		.get(person.id) as { day: string } | undefined;
	if (next) {
		const batch = db
			.prepare(
				"SELECT * FROM memory_events WHERE person_id=? AND day=? AND processed=0 ORDER BY at,rowid LIMIT ?",
			)
			.all(person.id, next.day, promptConfig.memory.batchSize) as MemoryEvent[];
		const summary = (
			db
				.prepare("SELECT summary FROM memory_daily WHERE person_id=? AND day=?")
				.get(person.id, next.day) as { summary: string } | undefined
		)?.summary;
		const result = extraction.parse(
			await ask(config, model, "memory", promptConfig.memory.extract, {
				day: next.day,
				summary: summary ?? "",
				events: batch.map((e) => ({
					id: e.id,
					at: e.at,
					text: e.text,
					reply: e.reply,
					intent: e.intent,
					legacy: Boolean(e.legacy),
				})),
			}),
		);
		for (const fact of result.memories) {
			if (
				fact.evidenceIds.some(
					(id) =>
						!batch.some(
							(e) => e.id === id && ["insight", "both"].includes(e.intent),
						),
				)
			)
				throw new Error("invalid_evidence");
		}
		if (!alive(db, person)) return;
		db.transaction(() => {
			db.prepare(
				"INSERT INTO memory_daily VALUES(?,?,?,?) ON CONFLICT(person_id,day) DO UPDATE SET summary=excluded.summary,updated_at=excluded.updated_at",
			).run(person.id, next.day, result.summary, new Date().toISOString());
			for (const fact of result.memories)
				db.prepare(
					"INSERT INTO memory_facts(id,person_id,kind,text,evidence_json,created_at) VALUES(?,?,?,?,?,?)",
				).run(
					randomUUID(),
					person.id,
					fact.kind,
					fact.text,
					JSON.stringify([...new Set(fact.evidenceIds)]),
					new Date().toISOString(),
				);
			for (const e of batch)
				db.prepare("UPDATE memory_events SET processed=1 WHERE id=?").run(e.id);
		})();
	}
	if (!alive(db, person)) return;
	if (
		db
			.prepare(
				"SELECT 1 FROM memory_events WHERE person_id=? AND processed=0 LIMIT 1",
			)
			.get(person.id)
	)
		return;
	if (!wantProfile) return;
	const snapshot = db
		.prepare("SELECT * FROM memory_people WHERE id=?")
		.get(person.id) as Person;
	const facts = db
		.prepare(
			"SELECT * FROM memory_facts WHERE person_id=? AND invalidated_at IS NULL ORDER BY created_at,rowid",
		)
		.all(person.id) as Fact[];
	let profile: MemoryProfile = {
		overview: "目前还没有足够的本人表达支持长期性格观察。",
		traits: [],
		changes: "暂无足够证据。",
		limitations: "样本不足，不能据此确定稳定性格。",
	};
	const population = db
		.prepare(
			"SELECT count(*) AS messages,count(DISTINCT day) AS days,MIN(at) AS firstAt,MAX(at) AS lastAt FROM memory_events WHERE person_id=? AND intent IN ('insight','both')",
		)
		.get(person.id);
	// Bounded batches cover all active memories; each synthesis retains original evidence IDs.
	for (let i = 0; i < facts.length; i += promptConfig.memory.batchSize) {
		const batch = facts.slice(i, i + promptConfig.memory.batchSize);
		const allowed = new Set([
			...profile.traits.flatMap((t) => t.evidenceIds),
			...batch.flatMap((f) => JSON.parse(f.evidence_json) as string[]),
		]);
		profile = profileSchema.parse(
			await ask(config, model, "profile", promptConfig.memory.profile, {
				population,
				previous: profile,
				evidence: [...allowed].map((id) =>
					db
						.prepare(
							"SELECT id,at,text FROM memory_events WHERE id=? AND person_id=?",
						)
						.get(id, person.id),
				),
				memories: batch.map((f) => ({
					kind: f.kind,
					text: f.text,
					evidenceIds: JSON.parse(f.evidence_json),
					extractedAt: f.created_at,
				})),
			}),
		);
		if (
			profile.traits.some((t) => t.evidenceIds.some((id) => !allowed.has(id)))
		)
			throw new Error("invalid_evidence");
		if (!alive(db, snapshot, snapshot.revision)) return;
	}
	if (!alive(db, snapshot, snapshot.revision)) return;
	db.prepare("INSERT INTO memory_profiles VALUES(?,?,?,?,?,?,?)").run(
		randomUUID(),
		person.id,
		snapshot.revision,
		String(model.config.model),
		promptHash(),
		JSON.stringify(profile),
		new Date().toISOString(),
	);
	db.prepare("UPDATE memory_tasks SET want_profile=0 WHERE person_id=?").run(
		person.id,
	);
}

export function startMemoryWorker(db: SqliteDb, config: AppConfig) {
	// Deployment is single-process, matching the existing SQLite/poller architecture.
	db.prepare(
		"UPDATE memory_tasks SET status='pending' WHERE status='running'",
	).run();
	let busy = false,
		stopped = false;
	const tick = async () => {
		if (busy || stopped || !db.open) return;
		const task = db
			.prepare(
				"SELECT * FROM memory_tasks WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 1",
			)
			.get(new Date().toISOString()) as
			| { person_id: string; attempts: number; want_profile: number }
			| undefined;
		if (!task) return;
		const person = db
			.prepare("SELECT * FROM memory_people WHERE id=?")
			.get(task.person_id) as Person;
		busy = true;
		db.prepare(
			"UPDATE memory_tasks SET status='running' WHERE person_id=?",
		).run(person.id);
		try {
			await processMemoryTask(db, config, person, Boolean(task.want_profile));
			if (!alive(db, person) || stopped) return;
			const remaining = db
				.prepare(
					"SELECT 1 FROM memory_events WHERE person_id=? AND processed=0 LIMIT 1",
				)
				.get(person.id);
			const requested = db
				.prepare("SELECT want_profile FROM memory_tasks WHERE person_id=?")
				.get(person.id) as { want_profile: number } | undefined;
			db.prepare(
				"UPDATE memory_tasks SET status=?,attempts=0,error=NULL,available_at=? WHERE person_id=?",
			).run(
				remaining || requested?.want_profile ? "pending" : "done",
				new Date().toISOString(),
				person.id,
			);
		} catch {
			if (alive(db, person) && !stopped)
				db.prepare(
					"UPDATE memory_tasks SET status=?,attempts=attempts+1,error='记忆整理暂时失败，可稍后重试',available_at=? WHERE person_id=?",
				).run(
					task.attempts >= 4 ? "failed" : "pending",
					new Date(
						Date.now() + Math.min(300000, 10000 * 2 ** task.attempts),
					).toISOString(),
					person.id,
				);
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void tick(), 2000);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
