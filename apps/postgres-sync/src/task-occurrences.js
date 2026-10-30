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

  const folded = await foldTeamDuplicates(client);

  // Keep each occurrence's cycle and status in step with its tasks (Asana stays the day-to-day source).
  // A team occurrence is completed only when every linked task is.
  const refreshed = await client.query(`
    with agg as (
      select t.occurrence_id,
             (array_agg(t.cycle_record_id order by t.rev1_task_instance_id desc))[1] as cycle_record_id,
             case when bool_and(coalesce(t.task_completed, false)) then 'completed' else 'released' end as status
        from hb.rev1_task_instances t
       where t.occurrence_id is not null
       group by t.occurrence_id
    )
    update hb.work_occurrences o
       set cycle_record_id = agg.cycle_record_id, status = agg.status
      from agg
     where agg.occurrence_id = o.occurrence_id
       and o.status <> 'cancelled'
       and (o.cycle_record_id is distinct from agg.cycle_record_id or o.status is distinct from agg.status)
    returning o.occurrence_id
  `);
  return { linked: linked.rowCount || 0, refreshed: refreshed.rowCount || 0, ...folded };
}

// Team work used to be logged by duplicating a task per person (one assignee each). Copies of the same
// definition on the same VIN belong to one occurrence: each person's k-th copy joins occurrence k, so
// genuine repeats by the same person stay separate. Emptied occurrences are removed.
export async function foldTeamDuplicates(client) {
  const moved = await client.query(`
    with linked as (
      select t.rev1_task_instance_id, t.occurrence_id, o.task_definition_id, o.subject_key, o.occurrence_number,
             lower(coalesce(nullif(t.worker_email, ''), nullif(t.assignee_email, ''), '')) as who
        from hb.rev1_task_instances t
        join hb.work_occurrences o on o.occurrence_id = t.occurrence_id
       where o.subject_kind = 'vin'
    ), ranked as (
      select l.*, row_number() over (partition by l.task_definition_id, l.subject_key, l.who order by l.rev1_task_instance_id) as k
        from linked l
    ), targeted as (
      select r.*, first_value(r.occurrence_id) over (partition by r.task_definition_id, r.subject_key, r.k order by r.occurrence_number) as target_id
        from ranked r
    )
    update hb.rev1_task_instances t
       set occurrence_id = targeted.target_id
      from targeted
     where t.rev1_task_instance_id = targeted.rev1_task_instance_id
       and targeted.occurrence_id <> targeted.target_id
    returning t.rev1_task_instance_id
  `);
  const removed = moved.rowCount ? await client.query(`
    delete from hb.work_occurrences o
     where o.subject_kind = 'vin'
       and not exists (select 1 from hb.rev1_task_instances t where t.occurrence_id = o.occurrence_id)
       -- Only occurrences created by linking tasks; planned work released later has no task yet by design.
       and (o.source like 'migration 039%' or o.source like 'hb rebuild%')
    returning o.occurrence_id
  `) : { rowCount: 0 };
  return { teamTasksFolded: moved.rowCount || 0, emptyOccurrencesRemoved: removed.rowCount || 0 };
}

// Qualification rule shared with the template average-time model: actual time above zero and no more than
// five hours over the template estimate.
export function qualifiesForAverage(actualSeconds, estimateSeconds) {
  if (!(actualSeconds > 0)) return false;
  return !(estimateSeconds > 0) || actualSeconds <= estimateSeconds + 5 * 3600;
}

const average = values => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);

// Per-person seconds for one task: Hawley timer sessions when present (helpers included), else the task's
// recorded actual time credited to its assignee.
function taskPeople(obs) {
  const split = obs.session_minutes && typeof obs.session_minutes === "object" ? obs.session_minutes : null;
  const people = {};
  if (split && Object.keys(split).length) {
    for (const [name, minutes] of Object.entries(split)) if (Number(minutes) > 0) people[name] = Number(minutes) * 60;
  } else {
    people[obs.worker || "Unknown"] = Number(obs.actual_seconds);
  }
  return people;
}

const mergePeople = (into, from) => {
  for (const [name, seconds] of Object.entries(from)) into[name] = (into[name] || 0) + seconds;
  return into;
};

// Task-time table: one row per definition, one cell per VIN (or per cycle), with averages. Team work is
// counted per occurrence, so two people's time on one task is one crew total (with a per-person split),
// not two half-tasks.
export function buildTaskTimeTable(observations, { mode = "vin", columns = 12, recent = 5 } = {}) {
  const occurrences = new Map();
  observations.forEach((obs, index) => {
    const id = obs.occurrence_id || `obs-${index}`;
    const occ = occurrences.get(id) || { ...obs, actual_seconds: 0, people: {}, completed_on: null };
    occ.actual_seconds += Number(obs.actual_seconds);
    mergePeople(occ.people, taskPeople(obs));
    if (!occ.completed_on || String(obs.completed_on || "") > String(occ.completed_on)) occ.completed_on = obs.completed_on;
    occurrences.set(id, occ);
  });

  const columnKey = occ => (mode === "cycle" ? occ.cycle_key || "no cycle" : occ.vin != null ? String(occ.vin) : `batch ${occ.cycle_key || ""}`.trim());
  const byDefinition = new Map();
  for (const occ of occurrences.values()) {
    const row = byDefinition.get(occ.task_definition_id) || {
      taskDefinitionId: occ.task_definition_id,
      taskName: occ.task_name,
      phaseName: occ.phase_name,
      estimateSeconds: occ.estimate_seconds,
      occurrences: [],
      cells: new Map(),
      cellPeople: new Map()
    };
    row.occurrences.push(occ);
    const key = columnKey(occ);
    row.cells.set(key, (row.cells.get(key) || 0) + occ.actual_seconds);
    row.cellPeople.set(key, mergePeople(row.cellPeople.get(key) || {}, occ.people));
    byDefinition.set(occ.task_definition_id, row);
  }

  // Columns: the most recent VINs (or cycles) that have any data, newest first.
  const columnLatest = new Map();
  for (const occ of occurrences.values()) {
    const key = mode === "cycle" ? occ.cycle_key || "no cycle" : occ.vin != null ? String(occ.vin) : null;
    if (!key) continue;
    const order = mode === "cycle" ? occ.cycle_order ?? 0 : Number(occ.vin);
    columnLatest.set(key, Math.max(columnLatest.get(key) ?? -Infinity, order));
  }
  const columnKeys = [...columnLatest.entries()].sort((a, b) => b[1] - a[1]).slice(0, columns).map(([key]) => key);

  const rows = [...byDefinition.values()].map(row => {
    const qualified = row.occurrences
      .filter(occ => qualifiesForAverage(occ.actual_seconds, Number(row.estimateSeconds)))
      .sort((a, b) => String(b.completed_on || "").localeCompare(String(a.completed_on || "")));
    const seconds = qualified.map(occ => occ.actual_seconds);
    const crew = qualified.map(occ => Object.values(occ.people).filter(value => value > 0).length || 1);
    const pick = keys => Object.fromEntries(keys.filter(key => row.cells.has(key)).map(key => [key, row.cells.get(key)]));
    return {
      taskDefinitionId: row.taskDefinitionId,
      taskName: row.taskName,
      phaseName: row.phaseName,
      estimateSeconds: row.estimateSeconds,
      count: seconds.length,
      excluded: row.occurrences.length - seconds.length,
      averageSeconds: average(seconds),
      recentAverageSeconds: average(seconds.slice(0, recent)),
      averageCrew: crew.length ? Math.round((crew.reduce((a, b) => a + b, 0) / crew.length) * 10) / 10 : null,
      lastCompletedOn: qualified[0]?.completed_on || null,
      cells: pick(columnKeys),
      cellPeople: Object.fromEntries(columnKeys.filter(key => row.cellPeople.has(key)).map(key => [key, row.cellPeople.get(key)]))
    };
  }).sort((a, b) => String(a.phaseName || "").localeCompare(String(b.phaseName || "")) || String(a.taskName).localeCompare(String(b.taskName)));

  return { columns: columnKeys, rows };
}

// Completed, timed work per task for the task-time table, newest first, with each task's occurrence,
// assignee and per-person Hawley timer minutes.
export async function taskTimeObservations(db, { phase = "", search = "" } = {}) {
  const result = await db.query(
    `with sessions as (
       select s.asana_task_gid, jsonb_object_agg(s.person, s.minutes) as session_minutes
         from (select asana_task_gid, coalesce(nullif(worker_name, ''), worker_key) as person, sum(coalesce(duration_minutes, 0))::int as minutes
                 from core.time_sessions group by 1, 2) s
        where s.minutes > 0
        group by s.asana_task_gid
     )
     select o.occurrence_id, o.task_definition_id, v.task_name, v.phase_name, v.estimated_task_time_seconds as estimate_seconds,
            t.vin, t.actual_time_seconds as actual_seconds, t.completed_on::text as completed_on,
            coalesce(nullif(t.worker_name, ''), nullif(t.worker_email, ''), nullif(t.assignee_name, '')) as worker,
            sessions.session_minutes,
            case when c.cycle_number is null then null else 'C' || c.cycle_number || '.' || to_char(c.start_date, 'YY') end as cycle_key,
            extract(epoch from c.start_date)::bigint as cycle_order
       from hb.work_occurrences o
       join hb.task_definition_versions v on v.task_definition_id = o.task_definition_id and v.version_number = o.version_number
       join hb.rev1_task_instances t on t.occurrence_id = o.occurrence_id
       left join hb.cycles c on c.cycle_record_id = t.cycle_record_id
       left join sessions on sessions.asana_task_gid = t.asana_task_gid
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
