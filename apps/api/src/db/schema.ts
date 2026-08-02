import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* Anonymous learner profiles (device-scoped, no PII). */
export const learners = pgTable(
  "learners",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    deviceId: varchar("device_id", { length: 128 }).notNull(),
    lang: varchar("lang", { length: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("learners_device_id_key").on(t.deviceId)],
);

/* Deterministic practice prompts (seeded). */
export const prompts = pgTable("prompts", {
  id: varchar("id", { length: 64 }).primaryKey(),
  lang: varchar("lang", { length: 8 }).notNull(),
  scenario: text("scenario").notNull(),
  situation: text("situation").notNull(),
  question: text("question").notNull(),
  questionTranslation: text("question_translation"),
  hints: jsonb("hints").$type<string[]>().notNull(),
  seconds: integer("seconds").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const practiceSessions = pgTable(
  "practice_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    learnerId: varchar("learner_id", { length: 64 })
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    promptId: varchar("prompt_id", { length: 64 })
      .notNull()
      .references(() => prompts.id, { onDelete: "restrict" }),
    lang: varchar("lang", { length: 8 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("practice_sessions_learner_idx").on(t.learnerId)],
);

/* Storage reference + metadata only — audio bytes live in object storage. */
export const audioRecordings = pgTable("audio_recordings", {
  id: varchar("id", { length: 64 }).primaryKey(),
  storageKey: text("storage_key").notNull(),
  mimeType: varchar("mime_type", { length: 128 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  durationSec: real("duration_sec").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const speakingAttempts = pgTable(
  "speaking_attempts",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    sessionId: varchar("session_id", { length: 64 })
      .notNull()
      .references(() => practiceSessions.id, { onDelete: "cascade" }),
    learnerId: varchar("learner_id", { length: 64 })
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    attemptIndex: integer("attempt_index").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("processing"),
    durationSec: real("duration_sec").notNull().default(0),
    mocked: boolean("mocked").notNull().default(false),
    audioId: varchar("audio_id", { length: 64 }).references(() => audioRecordings.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("speaking_attempts_session_idx").on(t.sessionId),
    uniqueIndex("speaking_attempts_session_index_key").on(t.sessionId, t.attemptIndex),
  ],
);

/* Structured provider output: transcript + assessment feedback. */
export const attemptResults = pgTable("attempt_results", {
  attemptId: varchar("attempt_id", { length: 64 })
    .primaryKey()
    .references(() => speakingAttempts.id, { onDelete: "cascade" }),
  transcript: text("transcript").notNull(),
  transcriptionProvider: varchar("transcription_provider", { length: 48 }).notNull(),
  assessmentProvider: varchar("assessment_provider", { length: 48 }).notNull(),
  overallScore: integer("overall_score").notNull(),
  feedback: jsonb("feedback").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savedExpressions = pgTable(
  "saved_expressions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    learnerId: varchar("learner_id", { length: 64 })
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    expressionId: varchar("expression_id", { length: 96 }).notNull(),
    lang: varchar("lang", { length: 8 }).notNull(),
    text: text("text").notNull(),
    reading: text("reading"),
    meaning: text("meaning").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saved_expressions_learner_expression_key").on(t.learnerId, t.expressionId)],
);

/* Append-only progress events (one per completed attempt). */
export const progressEvents = pgTable(
  "progress_events",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    learnerId: varchar("learner_id", { length: 64 })
      .notNull()
      .references(() => learners.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 64 })
      .notNull()
      .references(() => practiceSessions.id, { onDelete: "cascade" }),
    attemptIndex: integer("attempt_index").notNull(),
    score: integer("score").notNull(),
    day: varchar("day", { length: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("progress_events_learner_idx").on(t.learnerId)],
);
