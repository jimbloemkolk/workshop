import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** recording → transcribing → labeling → harvesting → reviewing → exported,
 * with `interrupted` (crash mid-recording) and `failed` as side exits.
 * Everything after `transcribing` is re-entrant. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
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

/** one row per ffmpeg run; >1 row means the recording was resumed after a
 * crash and `gapBeforeS` of real time is missing from the audio timeline */
export const recordingRuns = sqliteTable('recording_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  gapBeforeS: real('gap_before_s').notNull().default(0),
  firstSegment: integer('first_segment').notNull(),
})

export const markers = sqliteTable('markers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  /** positions on the audio timeline (gaps excluded), seconds */
  startS: real('start_s').notNull(),
  endS: real('end_s'),
  /** ok | discarded (sub-minimum tap) | unclosed (auto-closed at stop) */
  flag: text('flag').notNull().default('ok'),
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
  markerId: integer('marker_id'),
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
