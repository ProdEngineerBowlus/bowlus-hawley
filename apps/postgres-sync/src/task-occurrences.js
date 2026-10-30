// Links task instances to work occurrences (task template system, ramp step 2). Runs inside every HB
// rebuild, so tasks created in Asana or by Project Creator are linked within a rebuild of arriving.
// Same rules as migration 039: VIN tasks by definition + VIN, VIN-less tasks by schedule row, repeats
// numbered after the occurrences that already exist for that subject.

export async function linkTaskOccurrences(client) {
  const linked = await client.query(`
    with candidates as (
      select t.rev1_task_instance_id,
             t.tasks_key as task_definition_id,
             case when t.vin is not null then 'vin' else 'batch' end as subject_kind,
             case when t.vin is not null then t.vin::text else t.line_schedule_record_id end as subject_key,
             t.line_schedule_record_id,
             t.cycle_record_id,
             coalesce(t.task_completed, false) as completed
        from hb.rev1_task_instances t
        join hb.task_definitions d on d.task_definition_id = t.tasks_key
       where t.occurrence_id is null
         and (t.vin is not null or t.line_schedule_record_id is not null)
    ), numbered as (
      select c.*,
             coalesce((select max(o.occurrence_number) from hb.work_occurrences o
                        where o.task_definition_id = c.task_definition_id and o.subject_kind = c.subject_kind and o.subject_key = c.subject_key), 0)
             + row_number() over (partition by c.task_definition_id, c.subject_kind, c.subject_key order by c.rev1_task_instance_id) as occurrence_number
        from candidates c
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
