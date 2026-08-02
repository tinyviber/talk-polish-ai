create table if not exists learners (
  id varchar(64) primary key,
  device_id varchar(128) not null,
  lang varchar(8),
  created_at timestamptz not null default now()
);
create unique index if not exists learners_device_id_key on learners (device_id);

create table if not exists prompts (
  id varchar(64) primary key,
  lang varchar(8) not null,
  scenario text not null,
  situation text not null,
  question text not null,
  question_translation text,
  hints jsonb not null,
  seconds integer not null,
  sort_order integer not null default 0
);

create table if not exists practice_sessions (
  id varchar(64) primary key,
  learner_id varchar(64) not null references learners (id) on delete cascade,
  prompt_id varchar(64) not null references prompts (id) on delete restrict,
  lang varchar(8) not null,
  created_at timestamptz not null default now()
);
create index if not exists practice_sessions_learner_idx on practice_sessions (learner_id);

create table if not exists audio_recordings (
  id varchar(64) primary key,
  storage_key text not null,
  mime_type varchar(128) not null,
  size_bytes integer not null,
  duration_sec real not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists speaking_attempts (
  id varchar(64) primary key,
  session_id varchar(64) not null references practice_sessions (id) on delete cascade,
  learner_id varchar(64) not null references learners (id) on delete cascade,
  attempt_index integer not null,
  status varchar(24) not null default 'processing',
  duration_sec real not null default 0,
  mocked boolean not null default false,
  audio_id varchar(64) references audio_recordings (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists speaking_attempts_session_idx on speaking_attempts (session_id);
create unique index if not exists speaking_attempts_session_index_key
  on speaking_attempts (session_id, attempt_index);

create table if not exists attempt_results (
  attempt_id varchar(64) primary key references speaking_attempts (id) on delete cascade,
  transcript text not null,
  transcription_provider varchar(48) not null,
  assessment_provider varchar(48) not null,
  overall_score integer not null,
  feedback jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists saved_expressions (
  id varchar(64) primary key,
  learner_id varchar(64) not null references learners (id) on delete cascade,
  expression_id varchar(96) not null,
  lang varchar(8) not null,
  text text not null,
  reading text,
  meaning text not null,
  saved_at timestamptz not null default now()
);
create unique index if not exists saved_expressions_learner_expression_key
  on saved_expressions (learner_id, expression_id);

create table if not exists progress_events (
  id varchar(64) primary key,
  learner_id varchar(64) not null references learners (id) on delete cascade,
  session_id varchar(64) not null references practice_sessions (id) on delete cascade,
  attempt_index integer not null,
  score integer not null,
  day varchar(10) not null,
  created_at timestamptz not null default now()
);
create index if not exists progress_events_learner_idx on progress_events (learner_id);
