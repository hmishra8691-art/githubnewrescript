-- 0041 — a researcher's own order for the analyses of a survey.
--
-- The Analyses rail lists saved analyses in the order the researcher arranges
-- them (move up / move down), not by last edit. `position` is nullable: an
-- analysis that was never moved sorts after the arranged ones, newest first,
-- which is the order the list had before this column existed.
begin;

alter table analytics_analyses add column if not exists position integer;

create index if not exists analytics_analyses_position_idx
  on analytics_analyses (survey_id, position) where deleted_at is null;

commit;
