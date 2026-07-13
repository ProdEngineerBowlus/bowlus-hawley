alter table hb.phase_cycle_pace_overrides
  add column if not exists start_mode text not null default 'manual';

alter table hb.phase_cycle_pace_overrides
  drop constraint if exists chk_hb_phase_cycle_pace_start_mode;

alter table hb.phase_cycle_pace_overrides
  add constraint chk_hb_phase_cycle_pace_start_mode
  check (start_mode in ('manual', 'just_in_time'));
