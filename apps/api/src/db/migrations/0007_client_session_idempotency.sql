alter table practice_sessions add column if not exists client_session_id varchar(128);
create unique index if not exists practice_sessions_learner_client_session_key
  on practice_sessions (learner_id, client_session_id)
  where client_session_id is not null;
