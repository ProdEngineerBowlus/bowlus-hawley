// Links task instances to work occurrences (task template system, ramp step 2). Runs inside every HB
// rebuild, so tasks created in Asana or by Project Creator are linked within a rebuild of arriving.
// The definition comes from the task's template key, else from an admin mapping rule (task_mapping_rules:
// normalized name + phase, then name in any phase). The subject is the VIN (or the VIN at the start of a
// "VINs - …" project name such as "319 - Frontier"), else the schedule row, else the cycle + phase bucket.
// Repeats are numbered after the occurrences that already exist for that subject.

// Same normalization in SQL and JS: trimmed, lower case, single spaces.
export const NORMALIZED_NAME_SQL = "lower(regexp_replace(trim(coalesce(%s, '')), '\\s+', ' ', 'g'))";
export const normalizeTaskName = name => String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
const normalized = column => NORMALIZED_NAME_SQL.replace("%s", column);

export async function linkTaskOccurrences(client) {
  const linked = await client.query(`
    with base as (
      select t.rev1_task_instance_id, t.tasks_key, ${normalized("t.task_name")} as norm_name, coalesce(t.phase_label, '') as phase,
             coalesce(t.vin::text, case when t.asana_portfolio_name ilike 'VINs%' then substring(t.asana_project_name from '^\\s*(\\d{2,4})\\M') end) as vin_text,
             t.line_schedule_record_id, t.cycle_record_id, coalesce(t.task_completed, false) as completed
        from hb.rev1_task_instances t
       where t.occurrence_id is null
    ), resolved as (
      select b.*, coalesce(d.task_definition_id, rp.task_definition_id, ra.task_definition_id) as task_definition_id
        from base b
        left join hb.task_definitions d on d.task_definition_id = b.tasks_key
        left join hb.task_mapping_rules rp on rp.match_name = b.norm_name and rp.match_phase = b.phase and rp.action = 'map'
        left join hb.task_mapping_rules ra on ra.match_name = b.norm_name and ra.match_phase = '' and ra.action = 'map'
    ), candidates as (
      select r.rev1_task_instance_id, r.task_definition_id,
             case when r.vin_text is not null then 'vin' else 'batch' end as subject_kind,
             coalesce(r.vin_text, r.line_schedule_record_id,
                      case when r.cycle_record_id is not null and r.phase <> '' then 'cycle:' || r.cycle_record_id || ':' || r.phase end) as subject_key,
             r.line_schedule_record_id, r.cycle_record_id, r.completed
        from resolved r
       where r.task_definition_id is not null
    ), numbered as (
      select c.*,
             coalesce((select max(o.occurrence_number) from hb.work_occurrences o
                        where o.task_definition_id = c.task_definition_id and o.subject_kind = c.subject_kind and o.subject_key = c.subject_key), 0)
             + row_number() over (partition by c.task_definition_id, c.subject_kind, c.subject_key order by c.rev1_task_instance_id) as occurrence_number
        from candidates c
       where c.subject_key is not null
    ), keyed as (
      select n.*, 'occ:' || n.task_definition_id || ':' || n.subject_kind || ':' || n.subject_key || ':' || n.occurrence_number as occurrence_id,
             (select max(v.version_number) from hb.task_definition_versions v where v.task_definition_id = n.task_definition_id) as version_number
        from numbered n
    ), inserted as (
      insert into hb.work_occurrences (occurrence_id, task_definition_id, version_number, subject_kind, subject_key, occurrence_number,
                                       production_record_id, cycle_record_id, status, released_at, source)
      select k.occurrence_id, k.task_definition_id, k.version_number, k.subject_kind, k.subject_key, k.occurrence_number,
             k.line_schedule_record_id, k.cycle_record_id, case when k.completed then 'completed' else 'released' end, now(), 'hb rebuild: new task'
        from keyed k
      on conflict (occurrence_id) do nothing
      returning occurrence_id
    )
    update hb.rev1_task_instances t
       set occurrence_id = k.occurrence_id
      from keyed k
     where t.rev1_task_instance_id = k.rev1_task_instance_id
    returning t.rev1_task_instance_id
  `);

  // Keep each occurrence's cycle and status in step with its task (Asana stays the day-to-day source).
  const refreshed = await client.query(`
    update hb.work_occurrences o
       set cycle_record_id = t.cycle_record_id,
           status = case when coalesce(t.task_completed, false) then 'completed' else 'released' end
      from hb.rev1_task_instances t
     where t.occurrence_id = o.occurrence_id
       and o.status <> 'cancelled'
       and (o.cycle_record_id is distinct from t.cycle_record_id
            or o.status is distinct from case when coalesce(t.task_completed, false) then 'completed' else 'released' end)
    returning o.occurrence_id
  `);
  return { linked: linked.rowCount || 0, refreshed: refreshed.rowCount || 0 };
}

// Qualification rule shared with the template average-time model: actual time above zero and no more than
// five hours over the template estimate.
export function qualifiesForAverage(actualSeconds, estimateSeconds) {
  if (!(actualSeconds > 0)) return false;
  return !(estimateSeconds > 0) || actualSeconds <= estimateSeconds + 5 * 3600;
}

const average = values => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

// Task-time table: one row per definition, one cell per VIN (or per cycle), with averages.
export function buildTaskTimeTable(observations, { mode = "vin", columns = 12, recent = 5 } = {}) {
  const byDefinition = new Map();
  for (const obs of observations) {
    const row = byDefinition.get(obs.task_definition_id) || {
      taskDefinitionId: obs.task_definition_id,
      taskName: obs.task_name,
      phaseName: obs.phase_name,
      estimateSeconds: obs.estimate_seconds,
      observations: [],
      cells: new Map()
    };
    row.observations.push(obs);
    const key = mode === "cycle" ? obs.cycle_key || "no cycle" : obs.vin != null ? String(obs.vin) : `batch ${obs.cycle_key || ""}`.trim();
    row.cells.set(key, (row.cells.get(key) || 0) + Number(obs.actual_seconds));
    byDefinition.set(obs.task_definition_id, row);
  }

  // Columns: the most recent VINs (or cycles) that have any data, newest first.
  const columnLatest = new Map();
  for (const obs of observations) {
    const key = mode === "cycle" ? obs.cycle_key || "no cycle" : obs.vin != null ? String(obs.vin) : null;
    if (!key) continue;
    const order = mode === "cycle" ? obs.cycle_order ?? 0 : Number(obs.vin);
    columnLatest.set(key, Math.max(columnLatest.get(key) ?? -Infinity, order));
  }
  const columnKeys = [...columnLatest.entries()].sort((a, b) => b[1] - a[1]).slice(0, columns).map(([key]) => key);

  const rows = [...byDefinition.values()].map(row => {
    const qualified = row.observations
      .filter(obs => qualifiesForAverage(Number(obs.actual_seconds), Number(row.estimateSeconds)))
      .sort((a, b) => String(b.completed_on || "").localeCompare(String(a.completed_on || "")));
    const seconds = qualified.map(obs => Number(obs.actual_seconds));
    return {
      taskDefinitionId: row.taskDefinitionId,
      taskName: row.taskName,
      phaseName: row.phaseName,
      estimateSeconds: row.estimateSeconds,
      count: seconds.length,
      excluded: row.observations.length - seconds.length,
      averageSeconds: average(seconds),
      recentAverageSeconds: average(seconds.slice(0, recent)),
      lastCompletedOn: qualified[0]?.completed_on || null,
      cells: Object.fromEntries(columnKeys.filter(key => row.cells.has(key)).map(key => [key, row.cells.get(key)]))
    };
  }).sort((a, b) => String(a.phaseName || "").localeCompare(String(b.phaseName || "")) || String(a.taskName).localeCompare(String(b.taskName)));

  return { columns: columnKeys, rows };
}

// Completed, timed work per occurrence for the task-time table, newest first.
export async function taskTimeObservations(db, { phase = "", search = "" } = {}) {
  const result = await db.query(
    `select o.task_definition_id, v.task_name, v.phase_name, v.estimated_task_time_seconds as estimate_seconds,
            t.vin, t.actual_time_seconds as actual_seconds, t.completed_on::text as completed_on,
            case when c.cycle_number is null then null else 'C' || c.cycle_number || '.' || to_char(c.start_date, 'YY') end as cycle_key,
            extract(epoch from c.start_date)::bigint as cycle_order
       from hb.work_occurrences o
       join hb.task_definition_versions v on v.task_definition_id = o.task_definition_id and v.version_number = o.version_number
       join hb.rev1_task_instances t on t.occurrence_id = o.occurrence_id
       left join hb.cycles c on c.cycle_record_id = t.cycle_record_id
      where coalesce(t.task_completed, false)
        and coalesce(t.actual_time_seconds, 0) > 0
        and ($1::text = '' or v.phase_name = $1::text)
        and ($2::text = '' or v.task_name ilike '%' || $2::text || '%')
      order by t.completed_on desc nulls last`,
    [String(phase || ""), String(search || "").trim()]
  );
  return result.rows;
}

// How much timed history the table covers, and how much still needs the unmapped-task review.
export async function taskTimeCoverage(db) {
  const result = await db.query(
    `select count(*) filter (where coalesce(task_completed, false) and coalesce(actual_time_seconds, 0) > 0)::int as timed_tasks,
            count(*) filter (where coalesce(task_completed, false) and coalesce(actual_time_seconds, 0) > 0 and occurrence_id is not null)::int as timed_linked,
            count(*) filter (where occurrence_id is null)::int as unlinked_tasks
       from hb.rev1_task_instances`
  );
  const phases = await db.query(`select distinct phase_name from hb.task_definition_versions where phase_name is not null order by phase_name`);
  return { ...result.rows[0], phases: phases.rows.map(row => row.phase_name) };
}

// Review groups: unlinked tasks grouped by normalized name + phase, with template suggestions by name
// (exact phase first). Groups already decided as "ignore" are left out.
export async function taskMappingGroups(db, { search = "", limit = 200 } = {}) {
  const groups = await db.query(
    `with u as materialized (
       select ${normalized("t.task_name")} as norm_name, coalesce(t.phase_label, '') as phase, t.task_name, t.vin,
              coalesce(t.actual_time_seconds, 0) > 0 and coalesce(t.task_completed, false) as timed,
              t.asana_project_name, coalesce(t.asana_portfolio_name, '') as portfolio, t.completed_on
         from hb.rev1_task_instances t
        where t.occurrence_id is null
     ), g as materialized (
       select norm_name, phase, min(task_name) as task_name, count(*)::int as tasks, count(*) filter (where timed)::int as timed_tasks,
              array_agg(distinct portfolio) as portfolios, (array_agg(distinct asana_project_name))[1:3] as projects,
              max(completed_on)::text as last_completed
         from u group by norm_name, phase
     ), defs as materialized (
       select distinct on (v.task_definition_id) v.task_definition_id, v.task_name, v.phase_name, ${normalized("v.task_name")} as norm_name
         from hb.task_definition_versions v order by v.task_definition_id, v.version_number desc
     ), suggestions as (
       -- One join for all groups; a per-group subquery came close to the 15 s statement timeout on live data.
       select g.norm_name, g.phase,
              json_agg(json_build_object('taskDefinitionId', d.task_definition_id, 'taskName', d.task_name, 'phaseName', d.phase_name,
                                         'samePhase', d.phase_name = g.phase) order by d.phase_name = g.phase desc, d.phase_name) as suggestions
         from g join defs d on d.norm_name = g.norm_name
        group by g.norm_name, g.phase
     )
     select g.*, coalesce(s.suggestions, '[]'::json) as suggestions,
            rp.action as rule_action, coalesce(rp.task_definition_id, ra.task_definition_id) as rule_definition_id
       from g
       left join suggestions s on s.norm_name = g.norm_name and s.phase = g.phase
       left join hb.task_mapping_rules rp on rp.match_name = g.norm_name and rp.match_phase = g.phase
       left join hb.task_mapping_rules ra on ra.match_name = g.norm_name and ra.match_phase = ''
      where coalesce(rp.action, ra.action, '') <> 'ignore'
        and ($1::text = '' or g.norm_name like '%' || lower($1::text) || '%' or lower(g.phase) = lower($1::text))
      order by g.timed_tasks desc, g.tasks desc
      limit $2::int`,
    [String(search || "").trim(), Math.min(Math.max(Number(limit) || 200, 1), 1000)]
  );
  const totals = await db.query(
    `select count(*)::int as unlinked, count(*) filter (where coalesce(actual_time_seconds, 0) > 0 and coalesce(task_completed, false))::int as unlinked_timed
       from hb.rev1_task_instances where occurrence_id is null`
  );
  const definitions = await db.query(
    `select distinct on (v.task_definition_id) v.task_definition_id as "taskDefinitionId", v.task_name as "taskName", v.phase_name as "phaseName"
       from hb.task_definition_versions v order by v.task_definition_id, v.version_number desc`
  );
  return { ...totals.rows[0], groups: groups.rows, definitions: definitions.rows };
}

// Saves admin decisions and links the affected tasks right away (inside the HB build gate).
export async function saveTaskMappingRules(client, rules, decidedBy = "") {
  for (const rule of rules) {
    const action = rule.action === "ignore" ? "ignore" : "map";
    const definitionId = action === "map" ? String(rule.taskDefinitionId || "") : null;
    if (action === "map" && !definitionId) throw Object.assign(new Error("Pick a template to map to."), { statusCode: 400 });
    await client.query(
      `insert into hb.task_mapping_rules (match_name, match_phase, action, task_definition_id, note, decided_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (match_name, match_phase) do update
         set action = excluded.action, task_definition_id = excluded.task_definition_id, note = excluded.note,
             decided_by = excluded.decided_by, decided_at = now()`,
      [normalizeTaskName(rule.name), String(rule.phase || ""), action, definitionId, String(rule.note || "").slice(0, 500), decidedBy]
    );
  }
  return linkTaskOccurrences(client);
}
