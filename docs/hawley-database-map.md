# Hawley database map (generated)

Generated from `bowlus_ops` on 2026-11-09 by `node scripts/hawley-db.mjs map docs/hawley-database-map.md`. Do not edit by hand; re-run after migrations.
See `docs/hawley-database-schema.md` for what each layer is for. Row counts are planner estimates.

## Contents

- **raw** (21): [airtable_cnc_parts_master](#rawairtable_cnc_parts_master), [airtable_cnc_sheets](#rawairtable_cnc_sheets), [airtable_cycles](#rawairtable_cycles), [airtable_models](#rawairtable_models), [airtable_phase_cycle_load](#rawairtable_phase_cycle_load), [airtable_phases](#rawairtable_phases), [airtable_production](#rawairtable_production), [airtable_schema_fields](#rawairtable_schema_fields), [airtable_schema_tables](#rawairtable_schema_tables), [airtable_task_instances](#rawairtable_task_instances), [airtable_tasks](#rawairtable_tasks), [airtable_vins](#rawairtable_vins), [airtable_work_force](#rawairtable_work_force), [airtable_worker_cycle_bank](#rawairtable_worker_cycle_bank), [airtable_worker_daily_actuals](#rawairtable_worker_daily_actuals), [airtable_worker_phase_allocation](#rawairtable_worker_phase_allocation), [asana_portfolio_projects](#rawasana_portfolio_projects), [asana_portfolios](#rawasana_portfolios), [asana_projects](#rawasana_projects), [asana_task_project_memberships](#rawasana_task_project_memberships), [asana_tasks](#rawasana_tasks)
- **hb** (42): [cnc_parts_master](#hbcnc_parts_master), [cnc_program_runtime_profiles](#hbcnc_program_runtime_profiles), [cnc_projects](#hbcnc_projects), [cnc_sheets](#hbcnc_sheets), [cnc_work_releases](#hbcnc_work_releases), [cycle_plan_versions](#hbcycle_plan_versions), [cycles](#hbcycles), [fabrication_releases](#hbfabrication_releases), [frames_projects](#hbframes_projects), [frames_work_releases](#hbframes_work_releases), [handoff_events](#hbhandoff_events), [handoff_lines](#hbhandoff_lines), [handoff_types](#hbhandoff_types), [handoffs](#hbhandoffs), [models](#hbmodels), [phase_cycle_load_rev1](#hbphase_cycle_load_rev1), [phase_cycle_pace_overrides](#hbphase_cycle_pace_overrides), [phase_releases](#hbphase_releases), [phases](#hbphases), [production_schedule](#hbproduction_schedule), [project_creation_runs](#hbproject_creation_runs), [release_pilots](#hbrelease_pilots), [release_settings](#hbrelease_settings), [rev1_task_instances](#hbrev1_task_instances), [task_definition_versions](#hbtask_definition_versions), [task_definitions](#hbtask_definitions), [task_helpers](#hbtask_helpers), [task_mapping_rules](#hbtask_mapping_rules), [task_template_cnc_sheet_links](#hbtask_template_cnc_sheet_links), [task_template_materials](#hbtask_template_materials), [task_template_part_links](#hbtask_template_part_links), [task_templates](#hbtask_templates), [team_task_settings](#hbteam_task_settings), [vin_gates](#hbvin_gates), [vins](#hbvins), [work_force](#hbwork_force), [work_occurrences](#hbwork_occurrences), [worker_cycle_bank_rev1](#hbworker_cycle_bank_rev1), [worker_daily_task_actuals](#hbworker_daily_task_actuals), [worker_phase_allocation_rev1](#hbworker_phase_allocation_rev1), [workflow_gates](#hbworkflow_gates), [workflow_stages](#hbworkflow_stages)
- **core** (22): [app_auth_events](#coreapp_auth_events), [app_sessions](#coreapp_sessions), [app_users](#coreapp_users), [assignment_events](#coreassignment_events), [capacity_recommendation_actions](#corecapacity_recommendation_actions), [capacity_recommendation_runs](#corecapacity_recommendation_runs), [cnc_machine_runs](#corecnc_machine_runs), [task_attachment_catalog](#coretask_attachment_catalog), [task_completion_evidence](#coretask_completion_evidence), [task_instances](#coretask_instances), [task_time_studies](#coretask_time_studies), [task_time_study_laps](#coretask_time_study_laps), [task_transition_events](#coretask_transition_events), [time_sessions](#coretime_sessions), [transition_category_catalog](#coretransition_category_catalog), [transition_gap_buckets](#coretransition_gap_buckets), [transition_reviews](#coretransition_reviews), [worker_app_issue_reports](#coreworker_app_issue_reports), [worker_day_schedule](#coreworker_day_schedule), [worker_task_capabilities](#coreworker_task_capabilities), [worker_task_events](#coreworker_task_events), [worker_task_sessions](#coreworker_task_sessions)
- **ops** (2): [manual_work_area_owner_hints](#opsmanual_work_area_owner_hints), [work_area_aliases](#opswork_area_aliases)
- **reporting** (30): [actual_vs_estimated_by_phase](#reportingactual_vs_estimated_by_phase), [actual_vs_estimated_by_task](#reportingactual_vs_estimated_by_task), [assigned_but_not_started](#reportingassigned_but_not_started), [assignee_work_history](#reportingassignee_work_history), [assignment_churn_by_phase](#reportingassignment_churn_by_phase), [assignment_churn_by_worker](#reportingassignment_churn_by_worker), [daily_owner_action_list](#reportingdaily_owner_action_list), [daily_worker_assignments](#reportingdaily_worker_assignments), [hawley_cycle_calendar](#reportinghawley_cycle_calendar), [hawley_reporting_day_summary](#reportinghawley_reporting_day_summary), [hawley_worker_page_assignments](#reportinghawley_worker_page_assignments), [lead_dispatch_delays](#reportinglead_dispatch_delays), [phase_day_summary](#reportingphase_day_summary), [phase_worker_labor_detail](#reportingphase_worker_labor_detail), [queue_starvation_events](#reportingqueue_starvation_events), [task_template_bom](#reportingtask_template_bom), [task_work_area_inference](#reportingtask_work_area_inference), [transition_event_detail](#reportingtransition_event_detail), [transition_gap_cause_summary](#reportingtransition_gap_cause_summary), [unreviewed_transition_queue](#reportingunreviewed_transition_queue), [work_area_owner_hints](#reportingwork_area_owner_hints), [work_area_owners](#reportingwork_area_owners), [work_force_capability_levels](#reportingwork_force_capability_levels), [worker_capability_map](#reportingworker_capability_map), [worker_daily_utilization](#reportingworker_daily_utilization), [worker_phase_day_summary](#reportingworker_phase_day_summary), [worker_task_capability_rankings](#reportingworker_task_capability_rankings), [worker_time_sessions](#reportingworker_time_sessions), [worker_transition_summary](#reportingworker_transition_summary), [worker_unaccounted_time](#reportingworker_unaccounted_time)
- **sync** (8): [airtable_task_time_writeback_state](#syncairtable_task_time_writeback_state), [asana_project_event_cursors](#syncasana_project_event_cursors), [asana_writeback_queue](#syncasana_writeback_queue), [errors](#syncerrors), [record_map](#syncrecord_map), [run_log](#syncrun_log), [schema_migrations](#syncschema_migrations), [source_watermarks](#syncsource_watermarks)

## raw

### raw.airtable_cnc_parts_master

table, ~1,057 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_cnc_sheets

table, ~141 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_cycles

table, ~25 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_models

table, ~10 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_phase_cycle_load

table, ~175 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_phases

table, ~21 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_production

table, ~312 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_schema_fields

table, ~378 rows

| Column | Type | Null | Default |
|---|---|---|---|
| table_id | text | no |  |
| field_id | text | no |  |
| table_name | text | no |  |
| field_name | text | no |  |
| field_type | text | yes |  |
| field_description | text | yes |  |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (table_id, field_id)`

### raw.airtable_schema_tables

table, ~14 rows

| Column | Type | Null | Default |
|---|---|---|---|
| table_id | text | no |  |
| table_name | text | no |  |
| primary_field_id | text | yes |  |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (table_id)`

### raw.airtable_task_instances

table, ~8,584 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| modified_at | timestamp with time zone | yes |  |
| synced_at | timestamp with time zone | no | now() |
| airtable_created_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_tasks

table, ~966 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_vins

table, ~183 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_work_force

table, ~19 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_worker_cycle_bank

table, ~195 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_worker_daily_actuals

table, ~3,446 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.airtable_worker_phase_allocation

table, ~292 rows

| Column | Type | Null | Default |
|---|---|---|---|
| record_id | text | no |  |
| fields_json | jsonb | no |  |
| airtable_created_at | timestamp with time zone | yes |  |
| modified_at | timestamp with time zone | yes |  |
| source_table_name | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (record_id)`

### raw.asana_portfolio_projects

table, ~74 rows

| Column | Type | Null | Default |
|---|---|---|---|
| portfolio_gid | text | no |  |
| project_gid | text | no |  |
| portfolio_name | text | yes |  |
| project_name | text | yes |  |
| task_type | text | yes |  |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (portfolio_gid, project_gid)`

### raw.asana_portfolios

table, ~6 rows

| Column | Type | Null | Default |
|---|---|---|---|
| gid | text | no |  |
| name | text | yes |  |
| workspace_gid | text | yes |  |
| workspace_name | text | yes |  |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (gid)`

### raw.asana_projects

table, ~75 rows

| Column | Type | Null | Default |
|---|---|---|---|
| gid | text | no |  |
| name | text | yes |  |
| archived | boolean | yes |  |
| modified_at | timestamp with time zone | yes |  |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |
| created_at | timestamp with time zone | yes |  |
| workspace_gid | text | yes |  |
| workspace_name | text | yes |  |
| permalink_url | text | yes |  |

- Primary key: `PRIMARY KEY (gid)`

### raw.asana_task_project_memberships

table, ~44,708 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_gid | text | no |  |
| project_gid | text | no |  |
| section_gid | text | no | ''::text |
| section_name | text | yes |  |
| is_source_project | boolean | no | false |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (task_gid, project_gid, section_gid)`

### raw.asana_tasks

table, ~25,458 rows

| Column | Type | Null | Default |
|---|---|---|---|
| gid | text | no |  |
| project_gid | text | yes |  |
| parent_gid | text | yes |  |
| name | text | yes |  |
| assignee_gid | text | yes |  |
| assignee_name | text | yes |  |
| completed | boolean | yes |  |
| completed_at | timestamp with time zone | yes |  |
| due_on | date | yes |  |
| actual_time_minutes | integer | yes |  |
| custom_fields_json | jsonb | no | '{}'::jsonb |
| modified_at | timestamp with time zone | yes |  |
| raw_json | jsonb | no |  |
| synced_at | timestamp with time zone | no | now() |
| assignee_email | text | yes |  |
| created_at | timestamp with time zone | yes |  |
| start_on | date | yes |  |
| start_at | timestamp with time zone | yes |  |
| due_at | timestamp with time zone | yes |  |
| permalink_url | text | yes |  |
| num_subtasks | integer | yes |  |

- Primary key: `PRIMARY KEY (gid)`

## hb

### hb.cnc_parts_master

table, ~1,057 rows

| Column | Type | Null | Default |
|---|---|---|---|
| part_record_id | text | no |  |
| part_number | text | yes |  |
| part_name | text | yes |  |
| quantity_on_sheet | numeric(12,4) | yes |  |
| total_count | numeric(12,4) | yes |  |
| retired | boolean | no | false |
| material_name | text | yes |  |
| sheet_material_names | text[] | no | '{}'::text[] |
| model_type_record_ids | text[] | no | '{}'::text[] |
| component_names | text[] | no | '{}'::text[] |
| sub_component_record_ids | text[] | no | '{}'::text[] |
| installation_phase_record_ids | text[] | no | '{}'::text[] |
| cnc_sheet_record_ids | text[] | no | '{}'::text[] |
| task_record_ids | text[] | no | '{}'::text[] |
| engineering_change_record_ids | text[] | no | '{}'::text[] |
| frame_class_names | text[] | no | '{}'::text[] |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_cnc_parts_master'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (part_record_id)`

### hb.cnc_program_runtime_profiles

table, ~137 rows

| Column | Type | Null | Default |
|---|---|---|---|
| program_key | text | no |  |
| program_name | text | no |  |
| gcode_relative_path | text | yes |  |
| completed_run_count | integer | no | 0 |
| total_attempt_count | integer | no | 0 |
| non_normal_attempt_count | integer | no | 0 |
| estimated_runtime_minutes | numeric(10,2) | yes |  |
| average_runtime_minutes | numeric(10,2) | yes |  |
| median_runtime_minutes | numeric(10,2) | yes |  |
| minimum_runtime_minutes | numeric(10,2) | yes |  |
| maximum_runtime_minutes | numeric(10,2) | yes |  |
| average_cut_length_meters | numeric(12,2) | yes |  |
| last_normal_run_at | timestamp with time zone | yes |  |
| confidence | text | no | 'no_observation'::text |
| source_system | text | no | 'de_job_history'::text |
| source_loaded_at | timestamp with time zone | no | now() |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (program_key)`

### hb.cnc_projects

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_label | text | no |  |
| project_name | text | no |  |
| asana_project_gid | text | yes |  |
| created_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (cycle_label)`

### hb.cnc_sheets

table, ~141 rows

| Column | Type | Null | Default |
|---|---|---|---|
| sheet_record_id | text | no |  |
| sheet_name | text | yes |  |
| sheet_number | numeric(12,4) | yes |  |
| material_name | text | yes |  |
| sheet_dimensions | text | yes |  |
| sheet_cost | numeric(12,4) | yes |  |
| inventory_location | text | yes |  |
| gross_weight | numeric(12,4) | yes |  |
| average_price_per_part | numeric(12,4) | yes |  |
| frame_class_names | text[] | no | '{}'::text[] |
| model_type_names | text[] | no | '{}'::text[] |
| part_record_ids | text[] | no | '{}'::text[] |
| task_record_ids | text[] | no | '{}'::text[] |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_cnc_sheets'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (sheet_record_id)`

### hb.cnc_work_releases

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_key | text | no |  |
| project_name | text | no |  |
| project_creation_run_id | text | no |  |
| task_count | integer | no | 0 |
| released_by | text | no | ''::text |
| released_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (cycle_key)`

### hb.cycle_plan_versions

table, ~2 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_plan_version_id | text | no |  |
| plan_year | integer | no |  |
| plan_hash | text | no |  |
| inputs_json | jsonb | no |  |
| cycles_json | jsonb | no |  |
| previous_cycles_json | jsonb | no |  |
| changed_cycle_numbers | integer[] | no | '{}'::integer[] |
| note | text | no | ''::text |
| published_by | text | no | ''::text |
| published_at | timestamp with time zone | no | now() |
| plan_group_id | text | yes |  |
| production_json | jsonb | no | '{}'::jsonb |
| asana_push_json | jsonb | no | '[]'::jsonb |

- Primary key: `PRIMARY KEY (cycle_plan_version_id)`

### hb.cycles

table, ~49 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_record_id | text | no |  |
| cycle_number | integer | yes |  |
| cycle_label | text | yes |  |
| start_date | date | yes |  |
| end_date | date | yes |  |
| quarter | text | yes |  |
| days_in_cycle | integer | yes |  |
| cycle_capacity | numeric(12,2) | yes |  |
| hours_per_workday | numeric(10,2) | yes |  |
| holidays | text | yes |  |
| cycle_percent | numeric(12,6) | yes |  |
| sequence_number | integer | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_bootstrap'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (cycle_record_id)`

### hb.fabrication_releases

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_key | text | no |  |
| cycle_label | text | yes |  |
| project_name | text | no |  |
| project_creation_run_id | text | no |  |
| task_count | integer | no | 0 |
| released_by | text | no | ''::text |
| released_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (cycle_key)`

### hb.frames_projects

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_label | text | no |  |
| project_name | text | no |  |
| asana_project_gid | text | yes |  |
| created_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (cycle_label)`

### hb.frames_work_releases

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_key | text | no |  |
| project_name | text | no |  |
| project_creation_run_id | text | no |  |
| task_count | integer | no | 0 |
| released_by | text | no | ''::text |
| released_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (cycle_key)`

### hb.handoff_events

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| event_id | bigint | no | nextval('hb.handoff_events_event_id_seq'::regclass) |
| handoff_id | bigint | no |  |
| event | text | no |  |
| actor | text | no | ''::text |
| at | timestamp with time zone | no | now() |
| details | jsonb | no | '{}'::jsonb |

- Foreign key: `FOREIGN KEY (handoff_id) REFERENCES hb.handoffs(handoff_id) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (event_id)`

### hb.handoff_lines

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| line_id | bigint | no | nextval('hb.handoff_lines_line_id_seq'::regclass) |
| handoff_id | bigint | no |  |
| sort_order | integer | no | 0 |
| item_key | text | no | ''::text |
| item_name | text | no |  |
| expected_qty | numeric(12,2) | no | 1 |
| packed_qty | numeric(12,2) | yes |  |
| packed_by | text | no | ''::text |
| packed_at | timestamp with time zone | yes |  |
| received_qty | numeric(12,2) | yes |  |
| received_by | text | no | ''::text |
| received_at | timestamp with time zone | yes |  |
| issue | text | no | ''::text |
| issue_note | text | no | ''::text |

- Foreign key: `FOREIGN KEY (handoff_id) REFERENCES hb.handoffs(handoff_id) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (line_id)`

### hb.handoff_types

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| type_key | text | no |  |
| name | text | no |  |
| from_stage | text | no |  |
| to_stage | text | no |  |
| scope | text | no | 'cycle'::text |
| contents_source | text | no | 'manual'::text |
| checklist | text[] | no | '{}'::text[] |
| active | boolean | no | false |
| notes | text | no | ''::text |
| updated_by | text | no | ''::text |
| updated_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (from_stage) REFERENCES hb.workflow_stages(stage_key)`
- Foreign key: `FOREIGN KEY (to_stage) REFERENCES hb.workflow_stages(stage_key)`
- Primary key: `PRIMARY KEY (type_key)`

### hb.handoffs

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| handoff_id | bigint | no | nextval('hb.handoffs_handoff_id_seq'::regclass) |
| type_key | text | no |  |
| cycle_label | text | no | ''::text |
| phase | text | no | ''::text |
| vin | text | no | ''::text |
| label | text | no |  |
| status | text | no | 'open'::text |
| checklist_done | text[] | no | '{}'::text[] |
| notes | text | no | ''::text |
| created_by | text | no | ''::text |
| created_at | timestamp with time zone | no | now() |
| delivered_by | text | no | ''::text |
| delivered_at | timestamp with time zone | yes |  |
| received_by | text | no | ''::text |
| received_at | timestamp with time zone | yes |  |

- Foreign key: `FOREIGN KEY (type_key) REFERENCES hb.handoff_types(type_key)`
- Primary key: `PRIMARY KEY (handoff_id)`
- Unique: `UNIQUE (type_key, cycle_label, phase, vin, label)`

### hb.models

table, ~10 rows

| Column | Type | Null | Default |
|---|---|---|---|
| model_record_id | text | no |  |
| model_name | text | yes |  |
| frame_class | text | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_models'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (model_record_id)`

### hb.phase_cycle_load_rev1

table, ~295 rows

| Column | Type | Null | Default |
|---|---|---|---|
| phase_cycle_bucket_key | text | no |  |
| display_bucket_key | text | yes |  |
| phase_record_id | text | yes |  |
| phase_name | text | yes |  |
| cycle_record_id | text | yes |  |
| cycle_label | text | yes |  |
| total_load_hours | numeric(12,2) | no | 0 |
| remaining_task_hours | numeric(12,2) | no | 0 |
| completed_task_hours | numeric(12,2) | no | 0 |
| coverage_percent | numeric(12,6) | no | 0 |
| imported_hours | numeric(12,2) | no | 0 |
| exported_hours | numeric(12,2) | no | 0 |
| completion_percent | numeric(12,6) | no | 0 |
| status | text | yes |  |
| hours_per_day | numeric(10,2) | no | 7.17 |
| task_instance_ids | bigint[] | no | '{}'::bigint[] |
| task_airtable_record_ids | text[] | no | '{}'::text[] |
| import_allocation_keys | text[] | no | '{}'::text[] |
| export_allocation_keys | text[] | no | '{}'::text[] |
| calculation_version | text | no | 'hb_rev1_batch_v1'::text |
| rebuilt_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (phase_cycle_bucket_key)`

### hb.phase_cycle_pace_overrides

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| phase_cycle_pace_override_id | text | no |  |
| cycle_number | integer | no |  |
| cycle_label | text | yes |  |
| phase_label | text | no |  |
| phase_label_key | text | no |  |
| true_start_date | date | no |  |
| note | text | yes |  |
| active | boolean | no | true |
| created_by | text | yes |  |
| updated_by | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |
| start_mode | text | no | 'manual'::text |

- Primary key: `PRIMARY KEY (phase_cycle_pace_override_id)`
- Unique: `UNIQUE (cycle_number, phase_label_key)`

### hb.phase_releases

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| vin | text | no |  |
| phase_name | text | no |  |
| production_record_id | text | yes |  |
| cycle_label | text | yes |  |
| project_creation_run_id | text | no |  |
| task_count | integer | no | 0 |
| released_by | text | no | ''::text |
| released_at | timestamp with time zone | no | now() |
| target | text | no | 'vin'::text |

- Foreign key: `FOREIGN KEY (vin) REFERENCES hb.release_pilots(vin) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (vin, phase_name)`

### hb.phases

table, ~21 rows

| Column | Type | Null | Default |
|---|---|---|---|
| phase_record_id | text | no |  |
| phase_name | text | yes |  |
| section_column | text | yes |  |
| process_order | numeric(10,2) | yes |  |
| installation_phase | text | yes |  |
| model_type | text | yes |  |
| frame_class | text | yes |  |
| task_offset | integer | yes |  |
| backfill_odd | integer | yes |  |
| backfill_even | integer | yes |  |
| group_size | integer | yes |  |
| parity_mode | text | yes |  |
| phase_skills | text | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_bootstrap'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (phase_record_id)`

### hb.production_schedule

table, ~600 rows

| Column | Type | Null | Default |
|---|---|---|---|
| production_record_id | text | no |  |
| schedule_key | text | yes |  |
| schedule_name | text | yes |  |
| cycle_number | integer | yes |  |
| cycle_label | text | yes |  |
| short_cycle_label | text | yes |  |
| cycle_record_id | text | yes |  |
| phase_record_id | text | yes |  |
| phase_name | text | yes |  |
| section_column | text | yes |  |
| asana_section | text | yes |  |
| vin | text | yes |  |
| vin_values | text[] | no | '{}'::text[] |
| vin_record_ids | text[] | no | '{}'::text[] |
| model_type | text | yes |  |
| start_date | date | yes |  |
| end_date | date | yes |  |
| days_in_cycle | integer | yes |  |
| task_instance_record_ids | text[] | no | '{}'::text[] |
| existing_rev1_task_instance_links | integer | no | 0 |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_production'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (production_record_id)`

### hb.project_creation_runs

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| project_creation_run_id | text | no |  |
| project_name | text | yes |  |
| project_type | text | yes |  |
| mode | text | no | 'asana_test_create'::text |
| status | text | no | 'started'::text |
| actor_email | text | yes |  |
| production_record_id | text | yes |  |
| cycle_record_id | text | yes |  |
| cycle_label | text | yes |  |
| phase_record_id | text | yes |  |
| phase_name | text | yes |  |
| vin | text | yes |  |
| asana_project_gid | text | yes |  |
| task_count | integer | no | 0 |
| root_task_count | integer | no | 0 |
| subtask_count | integer | no | 0 |
| estimated_seconds | integer | no | 0 |
| error_message | text | yes |  |
| request_json | jsonb | no | '{}'::jsonb |
| result_json | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| completed_at | timestamp with time zone | yes |  |

- Primary key: `PRIMARY KEY (project_creation_run_id)`

### hb.release_pilots

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| vin | text | no |  |
| lead_working_days | integer | no | 2 |
| asana_project_gid | text | yes |  |
| enrolled_by | text | no | ''::text |
| enrolled_at | timestamp with time zone | no | now() |
| frames_stage | boolean | no | true |

- Primary key: `PRIMARY KEY (vin)`

### hb.release_settings

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| settings_key | text | no | 'default'::text |
| auto_vin_phases | boolean | no | false |
| auto_fabrication | boolean | no | false |
| fabrication_lead_working_days | integer | no | 2 |
| updated_by | text | no | ''::text |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (settings_key)`

### hb.rev1_task_instances

table, ~25,021 rows

| Column | Type | Null | Default |
|---|---|---|---|
| rev1_task_instance_id | bigint | no | nextval('hb.rev1_task_instances_rev1_task_instance_id_seq'::regclass) |
| airtable_record_id | text | yes |  |
| task_instance_rev1_key | text | yes |  |
| airtable_key | text | yes |  |
| asana_airtable_key | text | yes |  |
| asana_task_gid | text | yes |  |
| asana_project_gid | text | yes |  |
| asana_project_name | text | yes |  |
| asana_portfolio_gid | text | yes |  |
| asana_portfolio_name | text | yes |  |
| asana_section | text | yes |  |
| parent_asana_task_gid | text | yes |  |
| parent_task_name | text | yes |  |
| parent_task | text | yes |  |
| is_subtask | boolean | no | false |
| inherited_from_parent | boolean | no | false |
| task_name | text | yes |  |
| task_description | text | yes |  |
| task_type | text | yes |  |
| task_order | numeric(12,2) | yes |  |
| status | text | yes |  |
| task_status | text | yes |  |
| task_completed | boolean | no | false |
| completed_on | date | yes |  |
| asana_due_date | date | yes |  |
| assigned_on | date | yes |  |
| worker_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| assignee_name | text | yes |  |
| assignee_email | text | yes |  |
| phase_record_id | text | yes |  |
| phase_label | text | yes |  |
| section_column | text | yes |  |
| phase_cycle_bucket_key | text | yes |  |
| phase_cycle_key | text | yes |  |
| cycle_record_id | text | yes |  |
| cycle_label | text | yes |  |
| vin | integer | yes |  |
| vin_text | text | yes |  |
| vin_record_id | text | yes |  |
| line_schedule_record_id | text | yes |  |
| tasks_record_id | text | yes |  |
| tasks_key | text | yes |  |
| model | text | yes |  |
| model_type | text | yes |  |
| start_date | date | yes |  |
| end_date | date | yes |  |
| quantity | numeric(12,4) | yes |  |
| estimated_task_time_seconds | integer | yes |  |
| estimated_batch_task_time_seconds | integer | yes |  |
| actual_time_seconds | integer | yes |  |
| actual_time_minutes | integer | yes |  |
| allocated_hours | numeric(12,2) | yes |  |
| completed_est_hours | numeric(12,2) | yes |  |
| open_est_hours | numeric(12,2) | yes |  |
| actual_efficiency | numeric(12,4) | yes |  |
| days_in_cycle | integer | yes |  |
| est_time_remaining_project_seconds | integer | yes |  |
| document_link | text | yes |  |
| attachment_summary | text | yes |  |
| active_in_production | boolean | no | false |
| production_match_status | text | yes |  |
| sync_status | boolean | no | false |
| last_synced_at | text | yes |  |
| rev1_import_notes | text | yes |  |
| phase_cycle_load_record_id | text | yes |  |
| worker_phase_allocation_record_id | text | yes |  |
| load_type | text | yes |  |
| proposed_worker | text | yes |  |
| proposed_worker_record_id | text | yes |  |
| proposed_start_date | date | yes |  |
| proposed_end_date | date | yes |  |
| scheduler_score | numeric(12,4) | yes |  |
| scheduler_status | text | yes |  |
| scheduler_mode | text | yes |  |
| scheduler_notes | text | yes |  |
| scheduler_snapshot_id | text | yes |  |
| scheduler_baseline_snapshot_id | text | yes |  |
| required_skill_scheduler | numeric(12,4) | yes |  |
| current_skill_level_scheduler | numeric(12,4) | yes |  |
| proposed_skill_level_scheduler | numeric(12,4) | yes |  |
| skill_gap_scheduler | numeric(12,4) | yes |  |
| overskill_scheduler | numeric(12,4) | yes |  |
| load_delta_hours_scheduler | numeric(12,4) | yes |  |
| scheduler_locked | boolean | no | false |
| push_to_asana | boolean | no | false |
| scheduling_evaluated_at | text | yes |  |
| scheduling_scope | text | yes |  |
| asana_push_status | text | yes |  |
| asana_push_result | text | yes |  |
| asana_pushed_at | text | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_bootstrap'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |
| occurrence_id | text | yes |  |
| asana_assigned_on | date | yes |  |

- Primary key: `PRIMARY KEY (rev1_task_instance_id)`
- Unique: `UNIQUE (airtable_record_id)`

### hb.task_definition_versions

table, ~929 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_definition_id | text | no |  |
| version_number | integer | no |  |
| effective_from_year | integer | yes |  |
| effective_from_cycle | integer | yes |  |
| task_name | text | no |  |
| phase_record_id | text | yes |  |
| phase_name | text | yes |  |
| model_type_record_ids | text[] | no | '{}'::text[] |
| estimated_task_time_seconds | integer | yes |  |
| estimated_batch_task_time_seconds | integer | yes |  |
| quantity | numeric(12,4) | yes |  |
| task_order | numeric(12,2) | yes |  |
| sop_link | text | yes |  |
| attachment_files_json | jsonb | no | '[]'::jsonb |
| task_description | text | yes |  |
| definition_json | jsonb | no | '{}'::jsonb |
| note | text | no | ''::text |
| created_by | text | no | ''::text |
| created_at | timestamp with time zone | no | now() |
| model_type_names | text[] | no | '{}'::text[] |
| required_skill_level | numeric(12,4) | yes |  |
| retired | boolean | no | false |

- Foreign key: `FOREIGN KEY (task_definition_id) REFERENCES hb.task_definitions(task_definition_id)`
- Primary key: `PRIMARY KEY (task_definition_id, version_number)`

### hb.task_definitions

table, ~929 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_definition_id | text | no |  |
| retired_from_year | integer | yes |  |
| retired_from_cycle | integer | yes |  |
| created_by | text | no | ''::text |
| created_at | timestamp with time zone | no | now() |
| current_version_number | integer | yes |  |

- Primary key: `PRIMARY KEY (task_definition_id)`

### hb.task_helpers

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| asana_task_gid | text | no |  |
| helper_email | text | no |  |
| helper_name | text | yes |  |
| helper_asana_gid | text | yes |  |
| synced_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (asana_task_gid, helper_email)`

### hb.task_mapping_rules

table, ~196 rows

| Column | Type | Null | Default |
|---|---|---|---|
| match_name | text | no |  |
| match_phase | text | no | ''::text |
| action | text | no |  |
| task_definition_id | text | yes |  |
| note | text | no | ''::text |
| decided_by | text | no | ''::text |
| decided_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (task_definition_id) REFERENCES hb.task_definitions(task_definition_id)`
- Primary key: `PRIMARY KEY (match_name, match_phase)`

### hb.task_template_cnc_sheet_links

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_record_id | text | no |  |
| sheet_record_id | text | no |  |
| link_sources | text[] | no | '{}'::text[] |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (task_record_id, sheet_record_id)`

### hb.task_template_materials

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_record_id | text | no |  |
| material_name | text | no |  |
| material_sources | text[] | no | '{}'::text[] |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (task_record_id, material_name)`

### hb.task_template_part_links

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_record_id | text | no |  |
| part_record_id | text | no |  |
| link_sources | text[] | no | '{}'::text[] |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (task_record_id, part_record_id)`

### hb.task_templates

table, ~929 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_record_id | text | no |  |
| tasks_key | text | yes |  |
| task_name | text | yes |  |
| parent_task_record_id | text | yes |  |
| parent_task_name | text | yes |  |
| task_order | numeric(12,2) | yes |  |
| quantity | numeric(12,4) | yes |  |
| estimated_task_time_seconds | integer | yes |  |
| estimated_batch_task_time_seconds | integer | yes |  |
| primary_phase_record_id | text | yes |  |
| primary_phase_name | text | yes |  |
| phase_record_ids | text[] | no | '{}'::text[] |
| phase_names | text[] | no | '{}'::text[] |
| primary_worker_record_id | text | yes |  |
| primary_worker_name | text | yes |  |
| assigned_worker_record_ids | text[] | no | '{}'::text[] |
| assigned_worker_names | text[] | no | '{}'::text[] |
| assignee_email | text | yes |  |
| document_link | text | yes |  |
| attachment_summary | text | yes |  |
| attachment_files_json | jsonb | no | '[]'::jsonb |
| task_description | text | yes |  |
| template_status | text | yes |  |
| active | boolean | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_tasks'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |
| parity_mode | text | yes |  |
| supported_phase_record_id | text | yes |  |
| supported_phase_name | text | yes |  |
| supported_offset | numeric(12,4) | yes |  |
| model_type_record_ids | text[] | no | '{}'::text[] |
| model_type_names | text[] | no | '{}'::text[] |
| frame_class_record_ids | text[] | no | '{}'::text[] |
| frame_class_names | text[] | no | '{}'::text[] |
| required_skill_level | numeric(12,4) | yes |  |
| has_bending | boolean | no | false |
| avg_time_seconds | numeric(14,4) | yes |  |
| avg_time_input_count | integer | yes |  |
| avg_time_quality | text | yes |  |

- Primary key: `PRIMARY KEY (task_record_id)`

### hb.team_task_settings

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| settings_key | text | no | 'default'::text |
| helpers_field_gid | text | yes |  |
| trial_worker_emails | text[] | no | '{}'::text[] |
| enabled_for_all | boolean | no | false |
| updated_by | text | no | ''::text |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (settings_key)`

### hb.vin_gates

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| vin | text | no |  |
| gate | text | no |  |
| status | text | no | 'passing'::text |
| passed_by | text | no | ''::text |
| passed_at | timestamp with time zone | no | now() |
| result | jsonb | no | '{}'::jsonb |

- Primary key: `PRIMARY KEY (vin, gate)`

### hb.vins

table, ~183 rows

| Column | Type | Null | Default |
|---|---|---|---|
| vin_record_id | text | no |  |
| vin | integer | yes |  |
| vin_text | text | yes |  |
| model_type_record_ids | text[] | no | '{}'::text[] |
| model_type_names | text[] | no | '{}'::text[] |
| frame_class_record_ids | text[] | no | '{}'::text[] |
| frame_class_names | text[] | no | '{}'::text[] |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_vins'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (vin_record_id)`

### hb.work_force

table, ~19 rows

| Column | Type | Null | Default |
|---|---|---|---|
| workforce_record_id | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| actively_employed | boolean | no | false |
| primary_phase_record_id | text | yes |  |
| home_section_column | text | yes |  |
| efficiency_factor | numeric(10,4) | no | 1 |
| ideal_efficiency_factor | numeric(10,4) | yes |  |
| fab_skill_level | numeric(10,2) | yes |  |
| cnc_skill_level | numeric(10,2) | yes |  |
| frames_skill_level | numeric(10,2) | yes |  |
| phase_a_skill_level | numeric(10,2) | yes |  |
| phase_b_skill_level | numeric(10,2) | yes |  |
| phase_c_skill_level | numeric(10,2) | yes |  |
| phase_d_skill_level | numeric(10,2) | yes |  |
| phase_e_skill_level | numeric(10,2) | yes |  |
| phase_f_skill_level | numeric(10,2) | yes |  |
| phase_g_skill_level | numeric(10,2) | yes |  |
| phase_h_skill_level | numeric(10,2) | yes |  |
| qc_inventory_skill_level | numeric(10,2) | yes |  |
| hours_per_day | numeric(10,2) | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_bootstrap'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (workforce_record_id)`

### hb.work_occurrences

table, ~14,564 rows

| Column | Type | Null | Default |
|---|---|---|---|
| occurrence_id | text | no |  |
| task_definition_id | text | no |  |
| version_number | integer | no |  |
| subject_kind | text | no |  |
| subject_key | text | no |  |
| occurrence_number | integer | no | 1 |
| production_record_id | text | yes |  |
| cycle_record_id | text | yes |  |
| status | text | no | 'released'::text |
| released_at | timestamp with time zone | yes |  |
| source | text | no |  |
| created_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (task_definition_id) REFERENCES hb.task_definitions(task_definition_id)`
- Foreign key: `FOREIGN KEY (task_definition_id, version_number) REFERENCES hb.task_definition_versions(task_definition_id, version_number)`
- Primary key: `PRIMARY KEY (occurrence_id)`
- Unique: `UNIQUE (task_definition_id, subject_kind, subject_key, occurrence_number)`

### hb.worker_cycle_bank_rev1

table, ~313 rows

| Column | Type | Null | Default |
|---|---|---|---|
| worker_cycle_key | text | no |  |
| worker_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| cycle_record_id | text | yes |  |
| cycle_label | text | yes |  |
| assigned_hours_total | numeric(12,2) | no | 0 |
| remaining_hours | numeric(12,2) | no | 0 |
| cycle_capacity | numeric(12,2) | no | 0 |
| effective_hours_bank | numeric(12,2) | no | 0 |
| actively_employed | boolean | no | false |
| days_in_cycle | integer | yes |  |
| efficiency_factor | numeric(10,4) | no | 1 |
| wpa_record_keys | text[] | no | '{}'::text[] |
| calculation_version | text | no | 'hb_rev1_batch_v1'::text |
| rebuilt_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_cycle_key)`

### hb.worker_daily_task_actuals

table, ~4,037 rows

| Column | Type | Null | Default |
|---|---|---|---|
| worker_daily_actual_id | bigint | no | nextval('hb.worker_daily_task_actuals_worker_daily_actual_id_seq'::regclass) |
| airtable_record_id | text | yes |  |
| ledger_key | text | yes |  |
| work_date | date | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| asana_task_gid | text | yes |  |
| task_name | text | yes |  |
| task_url | text | yes |  |
| vin | text | yes |  |
| cycle_label | text | yes |  |
| phase_label | text | yes |  |
| assigned_hours | numeric(12,2) | yes |  |
| allocated_hours | numeric(12,2) | yes |  |
| actual_minutes | integer | yes |  |
| timer_minutes | integer | yes |  |
| asana_posted_minutes | integer | yes |  |
| source_label | text | yes |  |
| was_assigned_in_dat | boolean | no | false |
| was_recovered | boolean | no | false |
| completed | boolean | no | false |
| last_seen_at | timestamp with time zone | yes |  |
| notes | text | yes |  |
| daily_summary | boolean | no | false |
| daily_available_minutes | integer | yes |  |
| daily_logged_minutes | integer | yes |  |
| daily_efficiency_percent | numeric(12,4) | yes |  |
| daily_efficiency_under_75 | boolean | no | false |
| efficiency_snapshot_at | timestamp with time zone | yes |  |
| review_month | text | yes |  |
| review_year | integer | yes |  |
| fields_json | jsonb | no | '{}'::jsonb |
| source_system | text | no | 'airtable_bootstrap'::text |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_daily_actual_id)`
- Unique: `UNIQUE (airtable_record_id)`
- Unique: `UNIQUE (ledger_key)`

### hb.worker_phase_allocation_rev1

table, ~489 rows

| Column | Type | Null | Default |
|---|---|---|---|
| worker_cycle_phase_key | text | no |  |
| worker_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| cycle_record_id | text | yes |  |
| cycle_label | text | yes |  |
| worked_phase_record_id | text | yes |  |
| worked_phase_text | text | yes |  |
| home_phase_text | text | yes |  |
| is_home_phase | boolean | no | false |
| assigned_hours | numeric(12,2) | no | 0 |
| imported_hours | numeric(12,2) | no | 0 |
| exported_hours | numeric(12,2) | no | 0 |
| cross_phase_support | boolean | no | false |
| phase_cycle_bucket_key | text | yes |  |
| worked_bucket_key | text | yes |  |
| phase_cycle_load_key | text | yes |  |
| worker_cycle_key | text | yes |  |
| task_instance_ids | bigint[] | no | '{}'::bigint[] |
| task_airtable_record_ids | text[] | no | '{}'::text[] |
| calculation_version | text | no | 'hb_rev1_batch_v1'::text |
| rebuilt_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_cycle_phase_key)`

### hb.workflow_gates

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| gate_key | text | no |  |
| name | text | no |  |
| from_stage | text | no |  |
| to_stage | text | no |  |
| scope | text | no | 'vin'::text |
| rule | text | no | 'all_tasks_complete'::text |
| checklist | text[] | no | '{}'::text[] |
| pass_role | text | no | 'admin'::text |
| active | boolean | no | true |
| notes | text | no | ''::text |
| updated_by | text | no | ''::text |
| updated_at | timestamp with time zone | no | now() |
| auto_pass | boolean | no | true |

- Foreign key: `FOREIGN KEY (from_stage) REFERENCES hb.workflow_stages(stage_key)`
- Foreign key: `FOREIGN KEY (to_stage) REFERENCES hb.workflow_stages(stage_key)`
- Primary key: `PRIMARY KEY (gate_key)`

### hb.workflow_stages

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| stage_key | text | no |  |
| name | text | no |  |
| sort_order | integer | no | 0 |
| portfolio | text | no | ''::text |
| project_scope | text | no | 'cycle'::text |
| project_name_pattern | text | no | ''::text |
| phases | text[] | no | '{}'::text[] |
| work_areas | text[] | no | '{}'::text[] |
| moves_to_vin | boolean | no | false |
| active | boolean | no | true |
| notes | text | no | ''::text |
| updated_by | text | no | ''::text |
| updated_at | timestamp with time zone | no | now() |
| starts_from_cycle | text | no | ''::text |

- Primary key: `PRIMARY KEY (stage_key)`

## core

### core.app_auth_events

table, ~251 rows

| Column | Type | Null | Default |
|---|---|---|---|
| app_auth_event_id | bigint | no | nextval('core.app_auth_events_app_auth_event_id_seq'::regclass) |
| event_type | text | no |  |
| app_user_id | bigint | yes |  |
| username | text | yes |  |
| worker_key | text | yes |  |
| role | text | yes |  |
| success | boolean | no | false |
| reason | text | yes |  |
| ip_address | text | yes |  |
| user_agent | text | yes |  |
| payload | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (app_user_id) REFERENCES core.app_users(app_user_id) ON DELETE SET NULL`
- Primary key: `PRIMARY KEY (app_auth_event_id)`

### core.app_sessions

table, ~231 rows

| Column | Type | Null | Default |
|---|---|---|---|
| app_session_id | bigint | no | nextval('core.app_sessions_app_session_id_seq'::regclass) |
| session_token_hash | text | no |  |
| app_user_id | bigint | no |  |
| created_at | timestamp with time zone | no | now() |
| last_seen_at | timestamp with time zone | no | now() |
| expires_at | timestamp with time zone | no |  |
| revoked_at | timestamp with time zone | yes |  |
| ip_address | text | yes |  |
| user_agent | text | yes |  |

- Foreign key: `FOREIGN KEY (app_user_id) REFERENCES core.app_users(app_user_id) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (app_session_id)`
- Unique: `UNIQUE (session_token_hash)`

### core.app_users

table, ~20 rows

| Column | Type | Null | Default |
|---|---|---|---|
| app_user_id | bigint | no | nextval('core.app_users_app_user_id_seq'::regclass) |
| username | text | no |  |
| display_name | text | yes |  |
| email | text | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| role | text | no | 'worker'::text |
| active | boolean | no | false |
| password_hash | text | yes |  |
| password_set_at | timestamp with time zone | yes |  |
| temporary_password | boolean | no | true |
| last_login_at | timestamp with time zone | yes |  |
| failed_login_count | integer | no | 0 |
| locked_until | timestamp with time zone | yes |  |
| source_system | text | no | 'hawley_work_force'::text |
| source_synced_at | timestamp with time zone | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (app_user_id)`
- Unique: `UNIQUE (email)`
- Unique: `UNIQUE (username)`

### core.assignment_events

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| assignment_event_id | bigint | no | nextval('core.assignment_events_assignment_event_id_seq'::regclass) |
| event_key | text | yes |  |
| asana_task_gid | text | no |  |
| task_name | text | yes |  |
| project_gid | text | yes |  |
| project_name | text | yes |  |
| previous_assignee_gid | text | yes |  |
| previous_assignee_name | text | yes |  |
| previous_assignee_email | text | yes |  |
| new_assignee_gid | text | yes |  |
| new_assignee_name | text | yes |  |
| new_assignee_email | text | yes |  |
| changed_at_from_asana | timestamp with time zone | yes |  |
| detected_at | timestamp with time zone | no | now() |
| source | text | no | 'asana_poll'::text |
| cycle_label | text | yes |  |
| vin | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| assignment_state_before | jsonb | no | '{}'::jsonb |
| assignment_state_after | jsonb | no | '{}'::jsonb |
| notes | text | yes |  |
| created_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (assignment_event_id)`
- Unique: `UNIQUE (event_key)`

### core.capacity_recommendation_actions

table, ~461 rows

| Column | Type | Null | Default |
|---|---|---|---|
| recommendation_action_id | uuid | no |  |
| recommendation_id | uuid | no |  |
| task_instance_id | bigint | no |  |
| asana_task_gid | text | no |  |
| task_name | text | yes |  |
| task_record_id | text | yes |  |
| phase_label | text | yes |  |
| estimated_hours | numeric(12,2) | no | 0 |
| required_skill_level | numeric(12,2) | yes |  |
| previous_worker_record_id | text | yes |  |
| previous_worker_name | text | yes |  |
| previous_worker_email | text | yes |  |
| target_worker_record_id | text | no |  |
| target_worker_name | text | yes |  |
| target_worker_email | text | yes |  |
| capability_reason | text | yes |  |
| completion_count | integer | no | 0 |
| status | text | no | 'preview'::text |
| error_message | text | yes |  |
| committed_at | timestamp with time zone | yes |  |

- Foreign key: `FOREIGN KEY (recommendation_id) REFERENCES core.capacity_recommendation_runs(recommendation_id) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (recommendation_action_id)`

### core.capacity_recommendation_runs

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| recommendation_id | uuid | no |  |
| cycle_number | integer | no |  |
| cycle_label | text | yes |  |
| phase_label | text | no |  |
| requested_hours | numeric(12,2) | no |  |
| recommended_hours | numeric(12,2) | no | 0 |
| status | text | no | 'preview'::text |
| generated_by | text | yes |  |
| preview_json | jsonb | no | '{}'::jsonb |
| commit_result_json | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| expires_at | timestamp with time zone | no | (now() + '00:30:00'::interval) |
| committed_at | timestamp with time zone | yes |  |

- Primary key: `PRIMARY KEY (recommendation_id)`

### core.cnc_machine_runs

table, ~26 rows

| Column | Type | Null | Default |
|---|---|---|---|
| cnc_machine_run_id | bigint | no | nextval('core.cnc_machine_runs_cnc_machine_run_id_seq'::regclass) |
| machine_run_key | text | no |  |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| machine_key | text | no | 'de_cnc'::text |
| asana_task_gid | text | no |  |
| task_instance_id | bigint | yes |  |
| task_name | text | no |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| work_date | date | no |  |
| program_key | text | no |  |
| program_name | text | no |  |
| expected_runtime_minutes | numeric(10,2) | no |  |
| alert_after_minutes | numeric(10,2) | no |  |
| started_at | timestamp with time zone | no |  |
| stopped_at | timestamp with time zone | yes |  |
| machine_runtime_minutes | numeric(10,2) | yes |  |
| status | text | no | 'running'::text |
| overrun_alerted_at | timestamp with time zone | yes |  |
| stopped_by_email | text | yes |  |
| source_payload | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |
| actual_window_minutes | numeric(10,2) | yes |  |
| credited_machine_minutes | numeric(10,2) | yes |  |
| derived_manual_minutes | numeric(10,2) | yes |  |
| support_time_session_key | text | yes |  |

- Foreign key: `FOREIGN KEY (program_key) REFERENCES hb.cnc_program_runtime_profiles(program_key)`
- Primary key: `PRIMARY KEY (cnc_machine_run_id)`
- Unique: `UNIQUE (machine_run_key)`

### core.task_attachment_catalog

table, ~929 rows. Verified permanent attachment object references. Empty arrays explicitly certify tasks without attachments. No signed URLs or credentials.

| Column | Type | Null | Default |
|---|---|---|---|
| task_record_id | text | no |  |
| source_base_id | text | no |  |
| source_table_id | text | no |  |
| source_field_id | text | no |  |
| source_snapshot | text | no |  |
| attachment_files | jsonb | no |  |
| imported_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (task_record_id)`

### core.task_completion_evidence

table, ~9,349 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_completion_evidence_id | bigint | no | nextval('core.task_completion_evidence_task_completion_evidence_id_seq'::regclass) |
| evidence_key | text | no |  |
| task_instance_id | bigint | yes |  |
| airtable_record_id | text | yes |  |
| asana_task_gid | text | yes |  |
| task_record_id | text | no |  |
| tasks_key | text | yes |  |
| task_name | text | yes |  |
| required_skill_level | numeric(12,4) | yes |  |
| worker_identity | text | no |  |
| worker_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| completed_on | date | yes |  |
| started_at | timestamp with time zone | yes |  |
| completed_at | timestamp with time zone | yes |  |
| productive_minutes | numeric(12,2) | yes |  |
| estimated_minutes | numeric(12,2) | yes |  |
| quantity | numeric(12,4) | yes |  |
| minutes_per_unit | numeric(12,2) | yes |  |
| timing_source | text | no | 'completion_without_time'::text |
| evidence_confidence | text | no | 'low'::text |
| assisted | boolean | yes |  |
| contributor_count | integer | no | 1 |
| quality_status | text | no | 'unknown'::text |
| rework_required | boolean | yes |  |
| verified | boolean | no | false |
| verified_by | text | yes |  |
| verified_at | timestamp with time zone | yes |  |
| source_system | text | no | 'hb_rev1_history'::text |
| source_payload | jsonb | no | '{}'::jsonb |
| first_seen_at | timestamp with time zone | no | now() |
| last_refreshed_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (task_completion_evidence_id)`
- Unique: `UNIQUE (evidence_key)`

### core.task_instances

table, ~9,033 rows

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | nextval('core.task_instances_id_seq'::regclass) |
| airtable_record_id | text | yes |  |
| asana_task_gid | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| phase_name | text | yes |  |
| cycle_name | text | yes |  |
| vin | text | yes |  |
| assigned_on | date | yes |  |
| task_name | text | yes |  |
| task_status | text | yes |  |
| estimated_hours | numeric(10,2) | yes |  |
| actual_time_minutes | integer | yes |  |
| source_updated_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (id)`
- Unique: `UNIQUE (airtable_record_id)`

### core.task_time_studies

table, ~1,750 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_time_study_id | bigint | no | nextval('core.task_time_studies_task_time_study_id_seq'::regclass) |
| study_key | text | no |  |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| asana_task_gid | text | no |  |
| task_instance_id | bigint | yes |  |
| task_name | text | no |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| work_date | date | no |  |
| label | text | no |  |
| is_active | boolean | no | true |
| created_by_email | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| ended_at | timestamp with time zone | yes |  |
| ended_by_email | text | yes |  |
| ended_reason | text | yes |  |
| source_payload | jsonb | no | '{}'::jsonb |
| updated_at | timestamp with time zone | no | now() |
| auto_rule_key | text | yes |  |

- Primary key: `PRIMARY KEY (task_time_study_id)`
- Unique: `UNIQUE (study_key)`

### core.task_time_study_laps

table, ~191 rows

| Column | Type | Null | Default |
|---|---|---|---|
| task_time_study_lap_id | bigint | no | nextval('core.task_time_study_laps_task_time_study_lap_id_seq'::regclass) |
| lap_key | text | no |  |
| task_time_study_id | bigint | no |  |
| started_at | timestamp with time zone | no |  |
| stopped_at | timestamp with time zone | yes |  |
| duration_minutes | integer | yes |  |
| stop_reason | text | yes |  |
| started_by_email | text | yes |  |
| stopped_by_email | text | yes |  |
| source_payload | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |
| capture_mode | text | no | 'live'::text |
| notes | text | yes |  |

- Foreign key: `FOREIGN KEY (task_time_study_id) REFERENCES core.task_time_studies(task_time_study_id) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (task_time_study_lap_id)`
- Unique: `UNIQUE (lap_key)`

### core.task_transition_events

table, ~4,659 rows

| Column | Type | Null | Default |
|---|---|---|---|
| transition_event_id | bigint | no | nextval('core.task_transition_events_transition_event_id_seq'::regclass) |
| transition_key | text | yes |  |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| work_date | date | no |  |
| previous_task_gid | text | yes |  |
| previous_task_name | text | yes |  |
| next_task_gid | text | yes |  |
| next_task_name | text | yes |  |
| previous_phase_key | text | yes |  |
| previous_phase_name | text | yes |  |
| next_phase_key | text | yes |  |
| next_phase_name | text | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| reporting_phase_rule | text | no | 'previous_phase'::text |
| previous_task_ended_at | timestamp with time zone | yes |  |
| next_task_started_at | timestamp with time zone | yes |  |
| raw_gap_minutes | numeric(10,2) | no | 0 |
| gap_bucket | text | yes |  |
| allowed_transition_minutes | numeric(10,2) | no | 5 |
| excess_gap_minutes | numeric(10,2) | no | 0 |
| previous_task_completed | boolean | no | false |
| previous_task_estimated_minutes | integer | yes |  |
| previous_task_actual_minutes | integer | yes |  |
| previous_task_over_estimate | boolean | no | false |
| next_task_assigned_before_gap | boolean | yes |  |
| assignment_changed_during_gap | boolean | no | false |
| logged_out_alert_triggered | boolean | no | false |
| over_estimate_alert_triggered | boolean | no | false |
| auto_category | text | yes |  |
| auto_category_reason | text | yes |  |
| review_required | boolean | no | false |
| manager_category | text | yes |  |
| manager_category_group | text | yes |  |
| manager_notes | text | yes |  |
| reviewed_by | text | yes |  |
| reviewed_at | timestamp with time zone | yes |  |
| manager_flagged | boolean | no | false |
| source | text | no | 'hawley_worker_app'::text |
| source_payload | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (auto_category) REFERENCES core.transition_category_catalog(category_key)`
- Foreign key: `FOREIGN KEY (gap_bucket) REFERENCES core.transition_gap_buckets(bucket_key)`
- Foreign key: `FOREIGN KEY (manager_category) REFERENCES core.transition_category_catalog(category_key)`
- Primary key: `PRIMARY KEY (transition_event_id)`
- Unique: `UNIQUE (transition_key)`

### core.time_sessions

table, ~5,334 rows

| Column | Type | Null | Default |
|---|---|---|---|
| time_session_id | bigint | no | nextval('core.time_sessions_time_session_id_seq'::regclass) |
| session_key | text | yes |  |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| asana_task_gid | text | no |  |
| task_instance_id | bigint | yes |  |
| task_name | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| work_date | date | no |  |
| started_at | timestamp with time zone | no |  |
| stopped_at | timestamp with time zone | yes |  |
| duration_minutes | integer | yes |  |
| estimated_minutes | integer | yes |  |
| stop_reason | text | yes |  |
| submitted_to_asana | boolean | no | false |
| asana_sync_status | text | no | 'not_ready'::text |
| asana_time_entry_gid | text | yes |  |
| source | text | no | 'hawley_worker_app'::text |
| source_payload | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (time_session_id)`
- Unique: `UNIQUE (session_key)`

### core.transition_category_catalog

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| category_key | text | no |  |
| display_name | text | no |  |
| category_group | text | no |  |
| display_order | integer | no |  |
| manager_selectable | boolean | no | true |
| valid_for_auto_suggestion | boolean | no | true |
| notes | text | yes |  |
| active | boolean | no | true |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (category_key)`

### core.transition_gap_buckets

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| bucket_key | text | no |  |
| display_name | text | no |  |
| min_minutes | numeric(10,2) | no |  |
| max_minutes | numeric(10,2) | yes |  |
| display_order | integer | no |  |
| review_default | boolean | no | false |
| notes | text | yes |  |
| active | boolean | no | true |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (bucket_key)`

### core.transition_reviews

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| transition_review_id | bigint | no | nextval('core.transition_reviews_transition_review_id_seq'::regclass) |
| transition_event_id | bigint | no |  |
| reviewed_by | text | yes |  |
| reviewed_at | timestamp with time zone | no | now() |
| manager_category | text | no |  |
| manager_category_group | text | yes |  |
| manager_notes | text | yes |  |
| confidence | text | yes |  |
| action_required | boolean | no | false |
| followup_owner | text | yes |  |
| review_mode | text | no | 'review'::text |
| created_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (manager_category) REFERENCES core.transition_category_catalog(category_key)`
- Foreign key: `FOREIGN KEY (transition_event_id) REFERENCES core.task_transition_events(transition_event_id) ON DELETE CASCADE`
- Primary key: `PRIMARY KEY (transition_review_id)`

### core.worker_app_issue_reports

table, ~0 rows. Worker-reported Hawley app issues. Open or reviewed records mark the associated manager-only daily performance card Needs review; they never alter labor or pace values.

| Column | Type | Null | Default |
|---|---|---|---|
| worker_app_issue_report_id | bigint | no | nextval('core.worker_app_issue_reports_worker_app_issue_report_id_seq'::regclass) |
| issue_key | text | no |  |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| work_date | date | no |  |
| asana_task_gid | text | yes |  |
| task_name | text | yes |  |
| issue_type | text | no | 'app_issue'::text |
| detail | text | yes |  |
| status | text | no | 'open'::text |
| reported_by_email | text | yes |  |
| reported_at | timestamp with time zone | no | now() |
| resolved_by_email | text | yes |  |
| resolved_at | timestamp with time zone | yes |  |
| resolution_note | text | yes |  |
| source_payload | jsonb | no | '{}'::jsonb |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_app_issue_report_id)`
- Unique: `UNIQUE (issue_key)`

### core.worker_day_schedule

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| worker_day_schedule_id | bigint | no | nextval('core.worker_day_schedule_worker_day_schedule_id_seq'::regclass) |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| work_date | date | no |  |
| scheduled_hours | numeric(10,2) | no | 7.5 |
| shift_start | time without time zone | yes |  |
| shift_end | time without time zone | yes |  |
| lunch_minutes | integer | no | 30 |
| break_minutes | integer | no | 20 |
| expected_productive_hours | numeric(10,2) | yes |  |
| active | boolean | no | true |
| source_system | text | no | 'hawley_default'::text |
| source_note | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_day_schedule_id)`
- Unique: `UNIQUE (worker_key, work_date)`

### core.worker_task_capabilities

table, ~1,689 rows

| Column | Type | Null | Default |
|---|---|---|---|
| worker_identity | text | no |  |
| task_record_id | text | no |  |
| worker_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| task_name | text | yes |  |
| required_skill_level | numeric(12,4) | yes |  |
| completion_count | integer | no | 0 |
| timed_completion_count | integer | no | 0 |
| verified_completion_count | integer | no | 0 |
| solo_completion_count | integer | no | 0 |
| assisted_completion_count | integer | no | 0 |
| first_completed_on | date | yes |  |
| last_completed_on | date | yes |  |
| average_minutes | numeric(12,2) | yes |  |
| median_minutes | numeric(12,2) | yes |  |
| recent_median_minutes | numeric(12,2) | yes |  |
| best_valid_minutes | numeric(12,2) | yes |  |
| time_variability_minutes | numeric(12,2) | yes |  |
| average_minutes_per_unit | numeric(12,2) | yes |  |
| rework_count | integer | no | 0 |
| capability_status | text | no | 'not_observed'::text |
| evidence_confidence | text | no | 'low'::text |
| last_evidence_at | timestamp with time zone | yes |  |
| refreshed_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_identity, task_record_id)`

### core.worker_task_events

table, ~11,768 rows

| Column | Type | Null | Default |
|---|---|---|---|
| worker_task_event_id | bigint | no | nextval('core.worker_task_events_worker_task_event_id_seq'::regclass) |
| event_key | text | yes |  |
| worker_key | text | no |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| asana_task_gid | text | yes |  |
| task_instance_id | bigint | yes |  |
| task_name | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| work_date | date | yes |  |
| event_type | text | no |  |
| event_timestamp | timestamp with time zone | no |  |
| duration_minutes | integer | yes |  |
| source | text | no | 'hawley_worker_app'::text |
| synced_to_asana | boolean | no | false |
| sync_status | text | no | 'not_ready'::text |
| payload | jsonb | no | '{}'::jsonb |
| notes | text | yes |  |
| created_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (worker_task_event_id)`
- Unique: `UNIQUE (event_key)`

### core.worker_task_sessions

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | nextval('core.worker_task_sessions_id_seq'::regclass) |
| task_instance_id | bigint | yes |  |
| worker_email | text | yes |  |
| started_at | timestamp with time zone | no |  |
| stopped_at | timestamp with time zone | yes |  |
| elapsed_minutes | integer | yes |  |
| state | text | no | 'running'::text |
| asana_push_state | text | no | 'not_ready'::text |
| asana_pushed_at | timestamp with time zone | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (task_instance_id) REFERENCES core.task_instances(id)`
- Primary key: `PRIMARY KEY (id)`

## ops

### ops.manual_work_area_owner_hints

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| owner_hint_key | text | no |  |
| work_area_key | text | no |  |
| owner_person_name | text | yes |  |
| owner_person_email | text | yes |  |
| owner_role | text | no | 'practical_anchor'::text |
| confidence_label | text | no | 'manual'::text |
| source_label | text | no | 'local_hawley_seed'::text |
| notes | text | yes |  |
| active | boolean | no | true |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (work_area_key) REFERENCES ops.work_area_aliases(work_area_key)`
- Primary key: `PRIMARY KEY (owner_hint_key)`

### ops.work_area_aliases

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| work_area_key | text | no |  |
| display_name | text | no |  |
| skill_level_field | text | yes |  |
| phase_names | text[] | no | '{}'::text[] |
| section_names | text[] | no | '{}'::text[] |
| task_keywords | text[] | no | '{}'::text[] |
| notes | text | yes |  |
| active | boolean | no | true |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (work_area_key)`

## reporting

### reporting.actual_vs_estimated_by_phase

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| estimated_minutes | integer | yes |  |
| actual_minutes | integer | yes |  |
| efficiency_percent | numeric | yes |  |

### reporting.actual_vs_estimated_by_task

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| asana_task_gid | text | yes |  |
| task_name | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| estimated_minutes | integer | yes |  |
| actual_minutes | integer | yes |  |
| efficiency_percent | numeric | yes |  |
| worker_count | integer | yes |  |

### reporting.assigned_but_not_started

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| worker_identity | text | yes |  |
| asana_task_gid | text | yes |  |
| task_name | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| estimated_hours | numeric(10,2) | yes |  |
| completed | boolean | yes |  |

### reporting.assignee_work_history

view

| Column | Type | Null | Default |
|---|---|---|---|
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| work_area_key | text | yes |  |
| work_area_name | text | yes |  |
| task_count | integer | yes |  |
| completed_task_count | integer | yes |  |
| estimated_hours | numeric | yes |  |
| actual_hours | numeric | yes |  |
| first_assigned_on | date | yes |  |
| last_assigned_on | date | yes |  |
| observed_confidence | text | yes |  |

### reporting.assignment_churn_by_phase

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| assignment_change_count | integer | yes |  |
| touched_task_count | integer | yes |  |

### reporting.assignment_churn_by_worker

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_identity | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| assignment_change_count | integer | yes |  |
| touched_task_count | integer | yes |  |

### reporting.daily_owner_action_list

view

| Column | Type | Null | Default |
|---|---|---|---|
| action_type | text | yes |  |
| work_date | date | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| phase_name | text | yes |  |
| subject | text | yes |  |
| reason | text | yes |  |
| source_id | text | yes |  |
| created_at | timestamp with time zone | yes |  |

### reporting.daily_worker_assignments

view

| Column | Type | Null | Default |
|---|---|---|---|
| task_instance_id | bigint | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| assigned_on | date | yes |  |
| task_name | text | yes |  |
| task_status | text | yes |  |
| phase_name | text | yes |  |
| cycle_name | text | yes |  |
| vin | text | yes |  |
| estimated_hours | numeric(10,2) | yes |  |
| actual_time_minutes | integer | yes |  |
| asana_task_gid | text | yes |  |
| airtable_record_id | text | yes |  |
| normalized_at | timestamp with time zone | yes |  |

### reporting.hawley_cycle_calendar

view

| Column | Type | Null | Default |
|---|---|---|---|
| cycle_number | integer | yes |  |
| cycle_label | text | yes |  |
| start_date | date | yes |  |
| end_date | date | yes |  |
| days_in_cycle | integer | yes |  |
| holidays | jsonb | yes |  |
| synced_at | timestamp with time zone | yes |  |

### reporting.hawley_reporting_day_summary

view

| Column | Type | Null | Default |
|---|---|---|---|
| assigned_on | date | yes |  |
| cycle_name | text | yes |  |
| worker_count | integer | yes |  |
| task_count | integer | yes |  |
| completed_task_count | integer | yes |  |
| open_task_count | integer | yes |  |
| assigned_hours | numeric | yes |  |
| completed_hours | numeric | yes |  |
| remaining_hours | numeric | yes |  |

### reporting.hawley_worker_page_assignments

view

| Column | Type | Null | Default |
|---|---|---|---|
| task_instance_id | bigint | yes |  |
| airtable_record_id | text | yes |  |
| asana_task_gid | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| assigned_on | date | yes |  |
| task_name | text | yes |  |
| completed | boolean | yes |  |
| task_status | text | yes |  |
| phase_name | text | yes |  |
| cycle_name | text | yes |  |
| vin | text | yes |  |
| estimated_hours | numeric(10,2) | yes |  |
| actual_time_minutes | integer | yes |  |
| asana_permalink_url | text | yes |  |
| sop_link | text | yes |  |
| document_link | text | yes |  |
| section_column | text | yes |  |
| inferred_work_area_key | text | yes |  |
| inferred_work_area_name | text | yes |  |
| inference_source | text | yes |  |
| normalized_at | timestamp with time zone | yes |  |
| source_synced_at | timestamp with time zone | yes |  |
| required_skill_level | numeric(12,4) | yes |  |
| assignment_role | text | yes |  |

### reporting.lead_dispatch_delays

view

| Column | Type | Null | Default |
|---|---|---|---|
| transition_event_id | bigint | yes |  |
| transition_key | text | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| worker_identity | text | yes |  |
| work_date | date | yes |  |
| previous_task_gid | text | yes |  |
| previous_task_name | text | yes |  |
| next_task_gid | text | yes |  |
| next_task_name | text | yes |  |
| previous_phase_key | text | yes |  |
| previous_phase_name | text | yes |  |
| next_phase_key | text | yes |  |
| next_phase_name | text | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| reporting_phase_rule | text | yes |  |
| previous_task_ended_at | timestamp with time zone | yes |  |
| next_task_started_at | timestamp with time zone | yes |  |
| raw_gap_minutes | numeric(10,2) | yes |  |
| gap_bucket | text | yes |  |
| gap_bucket_name | text | yes |  |
| gap_bucket_order | integer | yes |  |
| allowed_transition_minutes | numeric(10,2) | yes |  |
| excess_gap_minutes | numeric(10,2) | yes |  |
| previous_task_completed | boolean | yes |  |
| previous_task_estimated_minutes | integer | yes |  |
| previous_task_actual_minutes | integer | yes |  |
| previous_task_over_estimate | boolean | yes |  |
| next_task_assigned_before_gap | boolean | yes |  |
| assignment_changed_during_gap | boolean | yes |  |
| logged_out_alert_triggered | boolean | yes |  |
| over_estimate_alert_triggered | boolean | yes |  |
| auto_category | text | yes |  |
| auto_category_name | text | yes |  |
| auto_category_group | text | yes |  |
| auto_category_reason | text | yes |  |
| review_required | boolean | yes |  |
| manager_category | text | yes |  |
| manager_category_name | text | yes |  |
| manager_category_group | text | yes |  |
| manager_notes | text | yes |  |
| reviewed_by | text | yes |  |
| reviewed_at | timestamp with time zone | yes |  |
| manager_flagged | boolean | yes |  |
| source | text | yes |  |
| created_at | timestamp with time zone | yes |  |
| updated_at | timestamp with time zone | yes |  |

### reporting.phase_day_summary

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| total_actual_task_minutes | integer | yes |  |
| total_actual_task_hours | numeric | yes |  |
| total_transition_minutes | numeric(12,2) | yes |  |
| excess_transition_minutes | numeric(12,2) | yes |  |
| total_estimated_minutes | integer | yes |  |
| efficiency_percent | numeric | yes |  |
| assigned_task_count | integer | yes |  |
| completed_task_count | integer | yes |  |
| assigned_vs_completed_percent | numeric | yes |  |
| started_task_count | integer | yes |  |
| worker_count | integer | yes |  |
| assigned_worker_count | integer | yes |  |
| assignment_change_count | integer | yes |  |
| task_churn_count | integer | yes |  |
| logged_out_alert_count | integer | yes |  |
| over_estimate_alert_count | integer | yes |  |
| gaps_requiring_review_count | integer | yes |  |
| reviewed_gap_count | integer | yes |  |
| unreviewed_gap_count | integer | yes |  |
| top_transition_category | text | yes |  |
| top_manager_category_group | text | yes |  |

### reporting.phase_worker_labor_detail

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| actual_task_minutes | integer | yes |  |
| actual_task_hours | numeric | yes |  |
| estimated_minutes | integer | yes |  |
| transition_minutes | numeric(12,2) | yes |  |
| excess_transition_minutes | numeric(12,2) | yes |  |
| efficiency_percent | numeric | yes |  |
| assigned_task_count | integer | yes |  |
| started_task_count | integer | yes |  |
| completed_task_count | integer | yes |  |
| assigned_vs_completed_percent | numeric | yes |  |
| task_session_count | integer | yes |  |
| task_churn_count | integer | yes |  |
| logged_out_alert_count | integer | yes |  |
| over_estimate_alert_count | integer | yes |  |
| gaps_requiring_review_count | integer | yes |  |
| top_transition_category | text | yes |  |
| top_manager_category_group | text | yes |  |

### reporting.queue_starvation_events

view

| Column | Type | Null | Default |
|---|---|---|---|
| transition_event_id | bigint | yes |  |
| transition_key | text | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| worker_identity | text | yes |  |
| work_date | date | yes |  |
| previous_task_gid | text | yes |  |
| previous_task_name | text | yes |  |
| next_task_gid | text | yes |  |
| next_task_name | text | yes |  |
| previous_phase_key | text | yes |  |
| previous_phase_name | text | yes |  |
| next_phase_key | text | yes |  |
| next_phase_name | text | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| reporting_phase_rule | text | yes |  |
| previous_task_ended_at | timestamp with time zone | yes |  |
| next_task_started_at | timestamp with time zone | yes |  |
| raw_gap_minutes | numeric(10,2) | yes |  |
| gap_bucket | text | yes |  |
| gap_bucket_name | text | yes |  |
| gap_bucket_order | integer | yes |  |
| allowed_transition_minutes | numeric(10,2) | yes |  |
| excess_gap_minutes | numeric(10,2) | yes |  |
| previous_task_completed | boolean | yes |  |
| previous_task_estimated_minutes | integer | yes |  |
| previous_task_actual_minutes | integer | yes |  |
| previous_task_over_estimate | boolean | yes |  |
| next_task_assigned_before_gap | boolean | yes |  |
| assignment_changed_during_gap | boolean | yes |  |
| logged_out_alert_triggered | boolean | yes |  |
| over_estimate_alert_triggered | boolean | yes |  |
| auto_category | text | yes |  |
| auto_category_name | text | yes |  |
| auto_category_group | text | yes |  |
| auto_category_reason | text | yes |  |
| review_required | boolean | yes |  |
| manager_category | text | yes |  |
| manager_category_name | text | yes |  |
| manager_category_group | text | yes |  |
| manager_notes | text | yes |  |
| reviewed_by | text | yes |  |
| reviewed_at | timestamp with time zone | yes |  |
| manager_flagged | boolean | yes |  |
| source | text | yes |  |
| created_at | timestamp with time zone | yes |  |
| updated_at | timestamp with time zone | yes |  |

### reporting.task_template_bom

view

| Column | Type | Null | Default |
|---|---|---|---|
| task_record_id | text | yes |  |
| tasks_key | text | yes |  |
| task_name | text | yes |  |
| primary_phase_name | text | yes |  |
| required_skill_level | numeric(12,4) | yes |  |
| part_count | integer | yes |  |
| part_numbers | text[] | yes |  |
| part_names | text[] | yes |  |
| sheet_count | integer | yes |  |
| sheet_names | text[] | yes |  |
| material_count | integer | yes |  |
| material_names | text[] | yes |  |
| source_synced_at | timestamp with time zone | yes |  |
| normalized_at | timestamp with time zone | yes |  |

### reporting.task_work_area_inference

view

| Column | Type | Null | Default |
|---|---|---|---|
| task_instance_id | bigint | yes |  |
| airtable_record_id | text | yes |  |
| asana_task_gid | text | yes |  |
| task_name | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| assigned_on | date | yes |  |
| task_status | text | yes |  |
| phase_name | text | yes |  |
| cycle_name | text | yes |  |
| vin | text | yes |  |
| estimated_hours | numeric(10,2) | yes |  |
| actual_time_minutes | integer | yes |  |
| inferred_work_area_key | text | yes |  |
| inferred_work_area_name | text | yes |  |
| inference_source | text | yes |  |
| normalized_at | timestamp with time zone | yes |  |

### reporting.transition_event_detail

view

| Column | Type | Null | Default |
|---|---|---|---|
| transition_event_id | bigint | yes |  |
| transition_key | text | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| worker_identity | text | yes |  |
| work_date | date | yes |  |
| previous_task_gid | text | yes |  |
| previous_task_name | text | yes |  |
| next_task_gid | text | yes |  |
| next_task_name | text | yes |  |
| previous_phase_key | text | yes |  |
| previous_phase_name | text | yes |  |
| next_phase_key | text | yes |  |
| next_phase_name | text | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| reporting_phase_rule | text | yes |  |
| previous_task_ended_at | timestamp with time zone | yes |  |
| next_task_started_at | timestamp with time zone | yes |  |
| raw_gap_minutes | numeric(10,2) | yes |  |
| gap_bucket | text | yes |  |
| gap_bucket_name | text | yes |  |
| gap_bucket_order | integer | yes |  |
| allowed_transition_minutes | numeric(10,2) | yes |  |
| excess_gap_minutes | numeric(10,2) | yes |  |
| previous_task_completed | boolean | yes |  |
| previous_task_estimated_minutes | integer | yes |  |
| previous_task_actual_minutes | integer | yes |  |
| previous_task_over_estimate | boolean | yes |  |
| next_task_assigned_before_gap | boolean | yes |  |
| assignment_changed_during_gap | boolean | yes |  |
| logged_out_alert_triggered | boolean | yes |  |
| over_estimate_alert_triggered | boolean | yes |  |
| auto_category | text | yes |  |
| auto_category_name | text | yes |  |
| auto_category_group | text | yes |  |
| auto_category_reason | text | yes |  |
| review_required | boolean | yes |  |
| manager_category | text | yes |  |
| manager_category_name | text | yes |  |
| manager_category_group | text | yes |  |
| manager_notes | text | yes |  |
| reviewed_by | text | yes |  |
| reviewed_at | timestamp with time zone | yes |  |
| manager_flagged | boolean | yes |  |
| source | text | yes |  |
| created_at | timestamp with time zone | yes |  |
| updated_at | timestamp with time zone | yes |  |

### reporting.transition_gap_cause_summary

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| category_key | text | yes |  |
| category_name | text | yes |  |
| category_group | text | yes |  |
| gap_count | integer | yes |  |
| total_gap_minutes | numeric(12,2) | yes |  |
| total_excess_minutes | numeric(12,2) | yes |  |
| unreviewed_count | integer | yes |  |

### reporting.unreviewed_transition_queue

view

| Column | Type | Null | Default |
|---|---|---|---|
| transition_event_id | bigint | yes |  |
| transition_key | text | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| worker_identity | text | yes |  |
| work_date | date | yes |  |
| previous_task_gid | text | yes |  |
| previous_task_name | text | yes |  |
| next_task_gid | text | yes |  |
| next_task_name | text | yes |  |
| previous_phase_key | text | yes |  |
| previous_phase_name | text | yes |  |
| next_phase_key | text | yes |  |
| next_phase_name | text | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| reporting_phase_rule | text | yes |  |
| previous_task_ended_at | timestamp with time zone | yes |  |
| next_task_started_at | timestamp with time zone | yes |  |
| raw_gap_minutes | numeric(10,2) | yes |  |
| gap_bucket | text | yes |  |
| gap_bucket_name | text | yes |  |
| gap_bucket_order | integer | yes |  |
| allowed_transition_minutes | numeric(10,2) | yes |  |
| excess_gap_minutes | numeric(10,2) | yes |  |
| previous_task_completed | boolean | yes |  |
| previous_task_estimated_minutes | integer | yes |  |
| previous_task_actual_minutes | integer | yes |  |
| previous_task_over_estimate | boolean | yes |  |
| next_task_assigned_before_gap | boolean | yes |  |
| assignment_changed_during_gap | boolean | yes |  |
| logged_out_alert_triggered | boolean | yes |  |
| over_estimate_alert_triggered | boolean | yes |  |
| auto_category | text | yes |  |
| auto_category_name | text | yes |  |
| auto_category_group | text | yes |  |
| auto_category_reason | text | yes |  |
| review_required | boolean | yes |  |
| manager_category | text | yes |  |
| manager_category_name | text | yes |  |
| manager_category_group | text | yes |  |
| manager_notes | text | yes |  |
| reviewed_by | text | yes |  |
| reviewed_at | timestamp with time zone | yes |  |
| manager_flagged | boolean | yes |  |
| source | text | yes |  |
| created_at | timestamp with time zone | yes |  |
| updated_at | timestamp with time zone | yes |  |

### reporting.work_area_owner_hints

view

| Column | Type | Null | Default |
|---|---|---|---|
| owner_hint_key | text | yes |  |
| work_area_key | text | yes |  |
| work_area_name | text | yes |  |
| owner_person_name | text | yes |  |
| owner_person_email | text | yes |  |
| owner_role | text | yes |  |
| confidence_label | text | yes |  |
| source_label | text | yes |  |
| notes | text | yes |  |
| matched_workforce_record_id | text | yes |  |
| matched_worker_name | text | yes |  |
| matched_worker_email | text | yes |  |
| active | boolean | yes |  |
| updated_at | timestamp with time zone | yes |  |

### reporting.work_area_owners

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_area_key | text | yes |  |
| work_area_name | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| signal_type | text | yes |  |
| signal_score | numeric | yes |  |
| confidence | text | yes |  |
| source | text | yes |  |

### reporting.work_force_capability_levels

view

| Column | Type | Null | Default |
|---|---|---|---|
| workforce_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| actively_employed | boolean | yes |  |
| hours_per_day | numeric | yes |  |
| home_section_column | text | yes |  |
| work_area_key | text | yes |  |
| work_area_name | text | yes |  |
| skill_level_field | text | yes |  |
| skill_level | numeric | yes |  |
| capability_band | text | yes |  |
| declared_confidence | text | yes |  |

### reporting.worker_capability_map

view

| Column | Type | Null | Default |
|---|---|---|---|
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| actively_employed | boolean | yes |  |
| hours_per_day | numeric | yes |  |
| home_section_column | text | yes |  |
| work_area_key | text | yes |  |
| work_area_name | text | yes |  |
| skill_level_field | text | yes |  |
| skill_level | numeric | yes |  |
| capability_band | text | yes |  |
| declared_confidence | text | yes |  |
| observed_task_count | integer | yes |  |
| observed_completed_task_count | integer | yes |  |
| observed_estimated_hours | numeric | yes |  |
| observed_actual_hours | numeric | yes |  |
| first_assigned_on | date | yes |  |
| last_assigned_on | date | yes |  |
| observed_confidence | text | yes |  |
| manual_owner_role | text | yes |  |
| manual_owner_confidence | text | yes |  |
| routing_signal | text | yes |  |
| routing_confidence | text | yes |  |

### reporting.worker_daily_utilization

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| scheduled_hours | numeric(10,2) | yes |  |
| productive_task_minutes | integer | yes |  |
| productive_task_hours | numeric | yes |  |
| estimated_minutes | integer | yes |  |
| total_transition_minutes | numeric(12,2) | yes |  |
| excess_transition_minutes | numeric(12,2) | yes |  |
| planned_break_minutes | integer | yes |  |
| unaccounted_minutes | numeric | yes |  |
| productive_utilization_percent | numeric | yes |  |
| accounted_utilization_percent | numeric | yes |  |
| task_efficiency_percent | numeric | yes |  |
| assigned_task_count | integer | yes |  |
| completed_task_count | integer | yes |  |
| assigned_vs_completed_percent | numeric | yes |  |
| task_count_started | integer | yes |  |
| task_session_count | integer | yes |  |
| transition_count | integer | yes |  |
| avg_transition_minutes | numeric | yes |  |
| median_transition_minutes | numeric | yes |  |
| max_transition_minutes | numeric | yes |  |
| gaps_0_2_count | integer | yes |  |
| gaps_2_5_count | integer | yes |  |
| gaps_5_10_count | integer | yes |  |
| gaps_10_20_count | integer | yes |  |
| gaps_20_45_count | integer | yes |  |
| gaps_45_plus_count | integer | yes |  |
| review_required_count | integer | yes |  |
| reviewed_transition_count | integer | yes |  |
| unreviewed_transition_count | integer | yes |  |
| assignment_change_count | integer | yes |  |
| task_churn_count | integer | yes |  |
| logged_out_alert_count | integer | yes |  |
| over_estimate_alert_count | integer | yes |  |
| manager_explained_transition_minutes | numeric(12,2) | yes |  |

### reporting.worker_phase_day_summary

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| phase_key | text | yes |  |
| phase_name | text | yes |  |
| actual_task_minutes | integer | yes |  |
| actual_task_hours | numeric | yes |  |
| estimated_minutes | integer | yes |  |
| transition_minutes | numeric(12,2) | yes |  |
| excess_transition_minutes | numeric(12,2) | yes |  |
| efficiency_percent | numeric | yes |  |
| assigned_task_count | integer | yes |  |
| started_task_count | integer | yes |  |
| completed_task_count | integer | yes |  |
| assigned_vs_completed_percent | numeric | yes |  |
| task_session_count | integer | yes |  |
| task_churn_count | integer | yes |  |
| logged_out_alert_count | integer | yes |  |
| over_estimate_alert_count | integer | yes |  |
| gaps_requiring_review_count | integer | yes |  |
| top_transition_category | text | yes |  |
| top_manager_category_group | text | yes |  |

### reporting.worker_task_capability_rankings

view

| Column | Type | Null | Default |
|---|---|---|---|
| worker_identity | text | yes |  |
| task_record_id | text | yes |  |
| worker_record_id | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| task_name | text | yes |  |
| required_skill_level | numeric(12,4) | yes |  |
| completion_count | integer | yes |  |
| timed_completion_count | integer | yes |  |
| verified_completion_count | integer | yes |  |
| solo_completion_count | integer | yes |  |
| assisted_completion_count | integer | yes |  |
| first_completed_on | date | yes |  |
| last_completed_on | date | yes |  |
| average_minutes | numeric(12,2) | yes |  |
| median_minutes | numeric(12,2) | yes |  |
| recent_median_minutes | numeric(12,2) | yes |  |
| best_valid_minutes | numeric(12,2) | yes |  |
| time_variability_minutes | numeric(12,2) | yes |  |
| average_minutes_per_unit | numeric(12,2) | yes |  |
| rework_count | integer | yes |  |
| capability_status | text | yes |  |
| evidence_confidence | text | yes |  |
| last_evidence_at | timestamp with time zone | yes |  |
| refreshed_at | timestamp with time zone | yes |  |
| evidence_rank | integer | yes |  |
| time_rank | integer | yes |  |

### reporting.worker_time_sessions

view

| Column | Type | Null | Default |
|---|---|---|---|
| session_key | text | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| worker_identity | text | yes |  |
| asana_task_gid | text | yes |  |
| task_name | text | yes |  |
| work_date | date | yes |  |
| started_at | timestamp with time zone | yes |  |
| stopped_at | timestamp with time zone | yes |  |
| duration_minutes | integer | yes |  |
| estimated_minutes | integer | yes |  |
| reporting_phase_key | text | yes |  |
| reporting_phase_name | text | yes |  |
| cycle_label | text | yes |  |
| vin | text | yes |  |
| completed | boolean | yes |  |
| source_label | text | yes |  |
| source_table | text | yes |  |
| source_payload | jsonb | yes |  |
| source_synced_at | timestamp with time zone | yes |  |

### reporting.worker_transition_summary

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| total_transition_minutes | numeric(12,2) | yes |  |
| excess_transition_minutes | numeric(12,2) | yes |  |
| transition_count | integer | yes |  |
| avg_transition_minutes | numeric | yes |  |
| median_transition_minutes | numeric | yes |  |
| max_transition_minutes | numeric | yes |  |
| gaps_0_2_count | integer | yes |  |
| gaps_2_5_count | integer | yes |  |
| gaps_5_10_count | integer | yes |  |
| gaps_10_20_count | integer | yes |  |
| gaps_20_45_count | integer | yes |  |
| gaps_45_plus_count | integer | yes |  |
| review_required_count | integer | yes |  |
| unreviewed_transition_count | integer | yes |  |

### reporting.worker_unaccounted_time

view

| Column | Type | Null | Default |
|---|---|---|---|
| work_date | date | yes |  |
| worker_key | text | yes |  |
| worker_name | text | yes |  |
| worker_email | text | yes |  |
| scheduled_hours | numeric(10,2) | yes |  |
| productive_task_hours | numeric | yes |  |
| total_transition_minutes | numeric(12,2) | yes |  |
| planned_break_minutes | integer | yes |  |
| unaccounted_minutes | numeric | yes |  |
| productive_utilization_percent | numeric | yes |  |
| accounted_utilization_percent | numeric | yes |  |
| review_required_count | integer | yes |  |

## sync

### sync.airtable_task_time_writeback_state

table, ~1,049 rows

| Column | Type | Null | Default |
|---|---|---|---|
| target_table | text | no |  |
| target_record_id | text | no |  |
| payload_hash | text | no |  |
| payload | jsonb | no | '{}'::jsonb |
| last_written_at | timestamp with time zone | no | now() |
| last_run_id | bigint | yes |  |

- Primary key: `PRIMARY KEY (target_table, target_record_id)`

### sync.asana_project_event_cursors

table, ~74 rows

| Column | Type | Null | Default |
|---|---|---|---|
| project_gid | text | no |  |
| project_name | text | yes |  |
| portfolio_gid | text | yes |  |
| portfolio_name | text | yes |  |
| sync_token | text | yes |  |
| initialized_at | timestamp with time zone | yes |  |
| last_polled_at | timestamp with time zone | yes |  |
| last_success_at | timestamp with time zone | yes |  |
| last_event_at | timestamp with time zone | yes |  |
| last_event_count | integer | no | 0 |
| last_changed_task_count | integer | no | 0 |
| needs_full_recrawl | boolean | no | false |
| error_count | integer | no | 0 |
| last_error | text | yes |  |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (project_gid)`

### sync.asana_writeback_queue

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| asana_writeback_id | bigint | no | nextval('sync.asana_writeback_queue_asana_writeback_id_seq'::regclass) |
| source_event_type | text | no |  |
| source_event_id | bigint | yes |  |
| worker_key | text | yes |  |
| asana_task_gid | text | yes |  |
| action_type | text | no |  |
| payload | jsonb | no | '{}'::jsonb |
| status | text | no | 'pending'::text |
| attempt_count | integer | no | 0 |
| last_attempt_at | timestamp with time zone | yes |  |
| completed_at | timestamp with time zone | yes |  |
| last_error | text | yes |  |
| created_at | timestamp with time zone | no | now() |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (asana_writeback_id)`

### sync.errors

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | nextval('sync.errors_id_seq'::regclass) |
| run_log_id | bigint | yes |  |
| source_system | text | yes |  |
| source_id | text | yes |  |
| error_type | text | yes |  |
| error_message | text | no |  |
| retry_state | text | no | 'new'::text |
| created_at | timestamp with time zone | no | now() |

- Foreign key: `FOREIGN KEY (run_log_id) REFERENCES sync.run_log(id)`
- Primary key: `PRIMARY KEY (id)`

### sync.record_map

table, ~8,584 rows

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | nextval('sync.record_map_id_seq'::regclass) |
| asana_task_gid | text | yes |  |
| airtable_record_id | text | yes |  |
| core_task_instance_id | bigint | yes |  |
| source_type | text | no |  |
| last_seen_at | timestamp with time zone | no | now() |
| last_synced_at | timestamp with time zone | yes |  |

- Foreign key: `FOREIGN KEY (core_task_instance_id) REFERENCES core.task_instances(id)`
- Primary key: `PRIMARY KEY (id)`

### sync.run_log

table, ~532,654 rows

| Column | Type | Null | Default |
|---|---|---|---|
| id | bigint | no | nextval('sync.run_log_id_seq'::regclass) |
| job_name | text | no |  |
| mode | text | no | 'dry-run'::text |
| status | text | no | 'running'::text |
| started_at | timestamp with time zone | no | now() |
| ended_at | timestamp with time zone | yes |  |
| records_read | integer | no | 0 |
| records_written | integer | no | 0 |
| error_count | integer | no | 0 |
| summary | jsonb | no | '{}'::jsonb |

- Primary key: `PRIMARY KEY (id)`

### sync.schema_migrations

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| filename | text | no |  |
| applied_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (filename)`

### sync.source_watermarks

table, ~0 rows

| Column | Type | Null | Default |
|---|---|---|---|
| source_name | text | no |  |
| watermark_value | text | yes |  |
| updated_at | timestamp with time zone | no | now() |

- Primary key: `PRIMARY KEY (source_name)`
