create table if not exists daily_story_sync_objects (
  conversation_id varchar(160) primary key,
  remote_revision integer not null default 1 check (remote_revision > 0),
  client_revision integer not null default 0 check (client_revision >= 0),
  session_instance_id varchar(160),
  content_hash varchar(64) not null,
  mutation_hash varchar(64) not null default '',
  deleted boolean not null default false,
  payload jsonb,
  last_mutation_id varchar(160) not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint daily_story_sync_payload_state_check check (
    (deleted and payload is null) or (not deleted and payload is not null)
  )
);

create index if not exists daily_story_sync_objects_updated_idx
  on daily_story_sync_objects (updated_at);

alter table daily_story_sync_objects
  add column if not exists mutation_hash varchar(64) not null default '';
