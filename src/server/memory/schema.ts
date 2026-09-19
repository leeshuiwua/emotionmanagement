export const memorySchema = `
CREATE TABLE IF NOT EXISTS memory_people (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, contact_id TEXT NOT NULL,
 epoch INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
 UNIQUE(channel_id,contact_id)
);
CREATE TABLE IF NOT EXISTS memory_events (
 id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES memory_people(id),
 message_id TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
 text TEXT NOT NULL, reply TEXT NOT NULL, intent TEXT NOT NULL,
 processed INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0,
 UNIQUE(person_id,message_id)
);
CREATE INDEX IF NOT EXISTS memory_event_person_day ON memory_events(person_id,day,at);
CREATE TABLE IF NOT EXISTS memory_daily (
 person_id TEXT NOT NULL REFERENCES memory_people(id), day TEXT NOT NULL,
 summary TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(person_id,day)
);
CREATE TABLE IF NOT EXISTS memory_facts (
 id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES memory_people(id),
 kind TEXT NOT NULL, text TEXT NOT NULL, evidence_json TEXT NOT NULL,
 created_at TEXT NOT NULL, invalidated_at TEXT, correction TEXT
);
CREATE INDEX IF NOT EXISTS memory_fact_person ON memory_facts(person_id,created_at);
CREATE TABLE IF NOT EXISTS memory_profiles (
 id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES memory_people(id),
 revision INTEGER NOT NULL, model TEXT NOT NULL, prompt_hash TEXT NOT NULL,
 result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_tasks (
 person_id TEXT PRIMARY KEY REFERENCES memory_people(id),
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available_at TEXT NOT NULL, error TEXT, want_profile INTEGER NOT NULL DEFAULT 0
);
`;
