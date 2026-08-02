do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'speaking_attempts_index_check'
      and conrelid = 'speaking_attempts'::regclass
  ) then
    alter table speaking_attempts
      add constraint speaking_attempts_index_check check (attempt_index in (1, 2));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'speaking_attempts_status_check'
      and conrelid = 'speaking_attempts'::regclass
  ) then
    alter table speaking_attempts
      add constraint speaking_attempts_status_check check (status in ('processing', 'ready', 'failed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'attempt_results_score_check'
      and conrelid = 'attempt_results'::regclass
  ) then
    alter table attempt_results
      add constraint attempt_results_score_check check (overall_score between 0 and 100);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'progress_events_attempt_index_check'
      and conrelid = 'progress_events'::regclass
  ) then
    alter table progress_events
      add constraint progress_events_attempt_index_check check (attempt_index in (1, 2));
  end if;
end
$migration$;

create unique index if not exists progress_events_session_attempt_key
  on progress_events (session_id, attempt_index);
