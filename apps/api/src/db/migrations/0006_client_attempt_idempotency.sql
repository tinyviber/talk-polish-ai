alter table speaking_attempts add column if not exists client_attempt_id varchar(128);
create index if not exists speaking_attempts_client_attempt_idx
  on speaking_attempts (learner_id, client_attempt_id);
create unique index if not exists speaking_attempts_learner_client_attempt_key
  on speaking_attempts (learner_id, client_attempt_id)
  where client_attempt_id is not null;
