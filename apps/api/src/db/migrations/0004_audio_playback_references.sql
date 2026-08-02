create table if not exists audio_playback_references (
  id varchar(64) primary key,
  learner_id varchar(64) not null references learners (id) on delete cascade,
  storage_key text not null,
  mime_type varchar(128) not null,
  expires_at timestamptz not null
);

create index if not exists audio_playback_references_learner_expiry_idx
  on audio_playback_references (learner_id, expires_at);
create index if not exists audio_playback_references_expiry_idx
  on audio_playback_references (expires_at);
