import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** calling → transcribing → labeling → harvesting → reviewing → exported,
 * with `failed` as a side exit. Everything after `transcribing` is
 * re-entrant. `origin: 'call'` sessions (two-party) skip labeling — track
 * identity is the speaker; `origin: 'local'` sessions (solo/table, one mic
 * possibly picking up several people) go through labeling like `import`
 * does, since diarization only produces anonymous speaker labels. Both
 * `local` and `call` are LiveKit rooms — `local` just means "recorded at the
 * table" (formerly avfoundation capture; now a single-publisher room). */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  origin: text('origin').notNull().default('local'), // local | import | call
  language: text('language').notNull().default('nl'),
  createdAt: integer('created_at').notNull(),
  /** duration of the concatenated recording, known after finalize */
  durationS: real('duration_s'),
  error: text('error'),
  exportedAt: integer('exported_at'),
})

export const participants = sqliteTable('participants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  name: text('name').notNull(),
})

/** one row per diarized speaker label; labeling assigns the participant */
export const speakers = sqliteTable('speakers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  label: text('label').notNull(),
  participantId: integer('participant_id'),
  /** a clear sample utterance for the labeling screen */
  sampleStartS: real('sample_start_s'),
  sampleEndS: real('sample_end_s'),
  sampleText: text('sample_text'),
})

/** Raw marks are per-participant and sacred: merging for harvest is a
 * derivation into harvest_spans, never a mutation here. */
export const markers = sqliteTable('markers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  /** positions on the audio timeline (gaps excluded), seconds */
  startS: real('start_s').notNull(),
  endS: real('end_s'),
  /** ok | discarded (sub-minimum tap) | unclosed (auto-closed at stop) */
  flag: text('flag').notNull().default('ok'),
  /** call identity (jim | jesse); null for local sessions */
  participant: text('participant'),
  /** hold (press-and-hold) | toggle (tap open, tap close) */
  mode: text('mode'),
  /** server | client — client for offline-queued edges flushed on reconnect */
  stampedBy: text('stamped_by').notNull().default('server'),
  createdAt: integer('created_at').notNull(),
})

export const harvests = sqliteTable('harvests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  /** latest Agent SDK session id — resuming appends turns (manual insights) */
  agentSessionId: text('agent_session_id'),
  model: text('model').notNull(),
  fixture: integer('fixture', { mode: 'boolean' }).notNull().default(false),
  status: text('status').notNull(), // running | done | failed
  error: text('error'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
})

export const insights = sqliteTable('insights', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  harvestId: integer('harvest_id'),
  origin: text('origin').notNull(), // marker | sweep | manual
  /** the merged span this insight came from; links back to raw markers */
  harvestSpanId: integer('harvest_span_id'),
  title: text('title').notNull(),
  /** word-index range into the transcript's words array, [start, end) */
  startWord: integer('start_word').notNull(),
  endWord: integer('end_word').notNull(),
  quote: text('quote').notNull(),
  insight: text('insight').notNull(),
  /** false = failed verbatim verification; needs human attention */
  anchored: integer('anchored', { mode: 'boolean' }).notNull().default(true),
  status: text('status').notNull().default('proposed'), // proposed | accepted | rejected
  createdAt: integer('created_at').notNull(),
  /** vault-relative note path once exported */
  exportedPath: text('exported_path'),
})

export const supportingQuotes = sqliteTable('supporting_quotes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  insightId: integer('insight_id').notNull(),
  startWord: integer('start_word').notNull(),
  endWord: integer('end_word').notNull(),
  quote: text('quote').notNull(),
  why: text('why'),
  anchored: integer('anchored', { mode: 'boolean' }).notNull().default(true),
})

/** A call participant's recording is an ordered list of track segments —
 * one file per track publication (reconnect/republish ⇒ a new row). Rows
 * are written at finalize, after hard file verification. */
export const trackSegments = sqliteTable('track_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  participant: text('participant').notNull(),
  /** session-dir-relative path, e.g. tracks/jim.1.ogg */
  file: text('file').notNull(),
  /** timeline offset from t0 (earliest egress audio start), seconds */
  startS: real('start_s').notNull(),
  durationS: real('duration_s').notNull(),
  /** LiveKit egress id, for webhook correlation */
  egressId: text('egress_id').notNull(),
})

/** Periods where mutual exchange broke down, derived at finalize from the
 * events.jsonl signal log. Purely additive: zero rows ⇒ today's behavior. */
export const gaps = sqliteTable('gaps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  participant: text('participant').notNull(),
  startS: real('start_s').notNull(),
  endS: real('end_s').notNull(),
  direction: text('direction').notNull(), // uplink | downlink | both
  cause: text('cause'),
})

/** Merged mark regions consumed by the harvester — wiped and re-derived on
 * each harvest; the derivation never touches markers rows. */
export const harvestSpans = sqliteTable('harvest_spans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  startS: real('start_s').notNull(),
  endS: real('end_s').notNull(),
  /** distinct participants whose marks merged in — >1 is a strength signal */
  participantCount: integer('participant_count').notNull().default(1),
})

export const harvestSpanMembers = sqliteTable('harvest_span_members', {
  harvestSpanId: integer('harvest_span_id').notNull(),
  markerId: integer('marker_id').notNull(),
})
