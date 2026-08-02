alter table attempt_results add column if not exists transcription jsonb;

create table if not exists storage_cleanup_jobs (
  id varchar(64) primary key,
  storage_key text not null,
  reason varchar(64) not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists storage_cleanup_jobs_next_attempt_idx
  on storage_cleanup_jobs (next_attempt_at);
