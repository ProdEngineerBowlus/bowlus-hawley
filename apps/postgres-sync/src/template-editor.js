// Task template editing (ramp step 3). Every edit is a new version of a task definition with an optional
// "applies from" cycle. When a version takes effect it is written to hb.task_templates and the attachment
// catalog, which Project Creator still reads; released work keeps the version it was released with.
import { randomUUID } from "node:crypto";

function editorError(message, statusCode = 400, code = "TEMPLATE_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

const VERSION_FIELDS = `v.task_definition_id, v.version_number, v.effective_from_year, v.effective_from_cycle, v.task_name, v.phase_record_id,
  v.phase_name, v.model_type_record_ids, v.model_type_names, v.estimated_task_time_seconds, v.estimated_batch_task_time_seconds,
  v.quantity, v.task_order, v.required_skill_level, v.sop_link, v.attachment_files_json, v.task_description, v.retired, v.note,
  v.created_by, v.created_at::text as created_at`;

export async function listTemplates(db, { phase = "", search = "", includeRetired = false } = {}) {
  const result = await db.query(
    `select ${VERSION_FIELDS}, d.current_version_number,
            (select max(f.version_number) from hb.task_definition_versions f where f.task_definition_id = d.task_definition_id) as latest_version_number,
            tt.avg_time_seconds, tt.avg_time_input_count
       from hb.task_definitions d
       join hb.task_definition_versions v on v.task_definition_id = d.task_definition_id and v.version_number = d.current_version_number
       left join hb.task_templates tt on tt.task_record_id = d.task_definition_id
      where ($1::text = '' or v.phase_name = $1::text)
        and ($2::text = '' or v.task_name ilike '%' || $2::text || '%')
        and ($3::boolean or not v.retired)
      order by v.phase_name nulls last, v.task_order nulls last, v.task_name
      limit 2000`,
    [String(phase || ""), String(search || "").trim(), Boolean(includeRetired)]
  );
  return result.rows;
}

export async function templateDetail(db, taskDefinitionId) {
  const versions = await db.query(
    `select ${VERSION_FIELDS} from hb.task_definition_versions v where v.task_definition_id = $1 order by v.version_number desc`,
    [taskDefinitionId]
  );
  if (!versions.rows.length) throw editorError("Template not found.", 404, "TEMPLATE_NOT_FOUND");
  const current = await db.query(`select current_version_number from hb.task_definitions where task_definition_id = $1`, [taskDefinitionId]);
  const usage = await db.query(
    `select count(*)::int as occurrences, count(*) filter (where status = 'completed')::int as completed from hb.work_occurrences where task_definition_id = $1`,
    [taskDefinitionId]
  );
  return { taskDefinitionId, currentVersionNumber: current.rows[0]?.current_version_number ?? null, versions: versions.rows, usage: usage.rows[0] };
}

// Reference lists for the editor: phases, models, upcoming cycles, and every stored attachment file
// (files can be reused across templates without uploading again).
export async function templateEditorOptions(db, today) {
  const [phases, models, cycles, files] = await Promise.all([
    db.query(`select phase_record_id, phase_name from hb.phases where phase_name is not null order by process_order nulls last, phase_name`),
    db.query(`select model_record_id, model_name from hb.models where model_name is not null order by model_name`),
    db.query(
      `select extract(year from start_date)::int as year, cycle_number as cycle, start_date::text as start_date
         from hb.cycles where end_date >= $1::date and cycle_number is not null order by start_date limit 40`,
      [today]
    ),
    db.query(
      `select distinct on (f.value ->> 'sha256') f.value as file
         from core.task_attachment_catalog c, jsonb_array_elements(c.attachment_files) f
        where coalesce((f.value ->> 'verified')::boolean, false)
        order by f.value ->> 'sha256'`
    )
  ]);
  return { phases: phases.rows, models: models.rows, cycles: cycles.rows, files: files.rows.map(row => row.file) };
}

async function cycleStart(db, year, cycle) {
  const result = await db.query(
    `select start_date::text as start_date from hb.cycles where cycle_number = $2::int and extract(year from start_date)::int = $1::int order by start_date limit 1`,
    [year, cycle]
  );
  return result.rows[0]?.start_date || null;
}

function cleanVersion(input, previous, phases, models) {
  const name = String(input.taskName ?? previous?.task_name ?? "").trim();
  if (!name) throw editorError("Task name is required.");
  const phase = phases.find(p => p.phase_record_id === (input.phaseRecordId ?? previous?.phase_record_id));
  if (!phase) throw editorError("Choose a phase.");
  const modelIds = (input.modelTypeRecordIds ?? previous?.model_type_record_ids ?? []).filter(Boolean);
  const unknownModel = modelIds.find(id => !models.some(m => m.model_record_id === id));
  if (unknownModel) throw editorError(`Unknown model ${unknownModel}.`);
  const minutes = value => (value === "" || value == null ? null : Math.round(Number(value) * 60));
  const estimate = input.estimateMinutes !== undefined ? minutes(input.estimateMinutes) : previous?.estimated_task_time_seconds ?? null;
  const batch = input.batchEstimateMinutes !== undefined ? minutes(input.batchEstimateMinutes) : previous?.estimated_batch_task_time_seconds ?? null;
  for (const [label, value] of [["Estimate", estimate], ["Batch estimate", batch]]) {
    if (value != null && !(Number.isFinite(value) && value >= 0)) throw editorError(`${label} must be zero or more minutes.`);
  }
  const files = input.attachmentFiles ?? previous?.attachment_files_json ?? [];
  for (const file of files) {
    if (!file?.bucket || !file?.key || !file?.sha256 || !file?.verified) throw editorError("Attachments must be verified stored files.");
  }
  const sop = String(input.sopLink ?? previous?.sop_link ?? "").trim();
  if (sop && !/^https?:\/\//i.test(sop)) throw editorError("SOP link must start with http:// or https://.");
  return {
    task_name: name,
    phase_record_id: phase.phase_record_id,
    phase_name: phase.phase_name,
    model_type_record_ids: modelIds,
    model_type_names: modelIds.map(id => models.find(m => m.model_record_id === id).model_name),
    estimated_task_time_seconds: estimate,
    estimated_batch_task_time_seconds: batch,
    quantity: input.quantity !== undefined ? (input.quantity === "" ? null : Number(input.quantity)) : previous?.quantity ?? null,
    task_order: input.taskOrder !== undefined ? (input.taskOrder === "" ? null : Number(input.taskOrder)) : previous?.task_order ?? null,
    required_skill_level: input.requiredSkillLevel !== undefined ? (input.requiredSkillLevel === "" ? null : Number(input.requiredSkillLevel)) : previous?.required_skill_level ?? null,
    sop_link: sop || null,
    attachment_files_json: files,
    task_description: input.taskDescription ?? previous?.task_description ?? null,
    retired: input.retired ?? false
  };
}

// Saves a new version (or a new template when taskDefinitionId is empty). appliesFrom: null = now, or
// { year, cycle }. Returns the saved version and whether it already took effect.
export async function saveTemplateVersion(client, input, { actor = "", today }) {
  const options = await templateEditorOptions(client, today);
  let definitionId = String(input.taskDefinitionId || "");
  let previous = null;
  if (definitionId) {
    const latest = await client.query(
      `select * from hb.task_definition_versions where task_definition_id = $1 order by version_number desc limit 1`,
      [definitionId]
    );
    previous = latest.rows[0];
    if (!previous) throw editorError("Template not found.", 404, "TEMPLATE_NOT_FOUND");
  } else {
    definitionId = `hawley-task:${randomUUID()}`;
    await client.query(`insert into hb.task_definitions (task_definition_id, created_by) values ($1, $2)`, [definitionId, actor]);
  }
  const version = cleanVersion(input, previous, options.phases, options.models);

  let effectiveYear = null;
  let effectiveCycle = null;
  if (input.appliesFrom) {
    effectiveYear = Number(input.appliesFrom.year);
    effectiveCycle = Number(input.appliesFrom.cycle);
    if (!(await cycleStart(client, effectiveYear, effectiveCycle))) throw editorError(`Cycle C${effectiveCycle}.${String(effectiveYear).slice(-2)} does not exist.`);
  }
  const versionNumber = (previous?.version_number || 0) + 1;
  await client.query(
    `insert into hb.task_definition_versions (task_definition_id, version_number, effective_from_year, effective_from_cycle, task_name,
       phase_record_id, phase_name, model_type_record_ids, model_type_names, estimated_task_time_seconds, estimated_batch_task_time_seconds,
       quantity, task_order, required_skill_level, sop_link, attachment_files_json, task_description, retired, definition_json, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19::jsonb, $20, $21)`,
    [definitionId, versionNumber, effectiveYear, effectiveCycle, version.task_name, version.phase_record_id, version.phase_name,
      version.model_type_record_ids, version.model_type_names, version.estimated_task_time_seconds, version.estimated_batch_task_time_seconds,
      version.quantity, version.task_order, version.required_skill_level, version.sop_link, JSON.stringify(version.attachment_files_json),
      version.task_description, version.retired, JSON.stringify({ editedFrom: previous?.version_number ?? null }), String(input.note || "").slice(0, 1000), actor]
  );
  const promoted = await promoteTemplateVersions(client, today, [definitionId]);
  return { taskDefinitionId: definitionId, versionNumber, effectiveFrom: effectiveYear ? { year: effectiveYear, cycle: effectiveCycle } : null, inEffect: promoted.includes(definitionId) };
}

// Makes the newest version whose "applies from" cycle has started the current one, and writes it to
// hb.task_templates and the attachment catalog. Runs on save and in every HB rebuild.
export async function promoteTemplateVersions(client, today, onlyIds = null) {
  const due = await client.query(
    `with effective as (
       select distinct on (v.task_definition_id) v.*
         from hb.task_definition_versions v
         left join hb.cycles c on c.cycle_number = v.effective_from_cycle and extract(year from c.start_date)::int = v.effective_from_year
        where (v.effective_from_year is null or c.start_date <= $1::date)
          and ($2::text[] is null or v.task_definition_id = any($2::text[]))
        order by v.task_definition_id, v.version_number desc
     )
     select e.* from effective e join hb.task_definitions d on d.task_definition_id = e.task_definition_id
      where d.current_version_number is distinct from e.version_number
        and ($2::text[] is null or e.task_definition_id = any($2::text[]))`,
    [today, onlyIds]
  );
  for (const v of due.rows) {
    await client.query(
      `insert into hb.task_templates (task_record_id, tasks_key, task_name, primary_phase_record_id, primary_phase_name, phase_record_ids, phase_names,
         model_type_record_ids, model_type_names, estimated_task_time_seconds, estimated_batch_task_time_seconds, quantity, task_order,
         required_skill_level, document_link, task_description, active, source_system, normalized_at)
       values ($1, $1, $2, $3, $4, array[$3], array[$4], $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'hawley_template_editor', now())
       on conflict (task_record_id) do update set
         task_name = excluded.task_name, primary_phase_record_id = excluded.primary_phase_record_id, primary_phase_name = excluded.primary_phase_name,
         phase_record_ids = excluded.phase_record_ids, phase_names = excluded.phase_names, model_type_record_ids = excluded.model_type_record_ids,
         model_type_names = excluded.model_type_names, estimated_task_time_seconds = excluded.estimated_task_time_seconds,
         estimated_batch_task_time_seconds = excluded.estimated_batch_task_time_seconds, quantity = excluded.quantity, task_order = excluded.task_order,
         required_skill_level = excluded.required_skill_level, document_link = excluded.document_link, task_description = excluded.task_description,
         active = excluded.active, source_system = excluded.source_system, normalized_at = now()`,
      [v.task_definition_id, v.task_name, v.phase_record_id, v.phase_name, v.model_type_record_ids, v.model_type_names,
        v.estimated_task_time_seconds, v.estimated_batch_task_time_seconds, v.quantity, v.task_order, v.required_skill_level,
        v.sop_link, v.task_description, !v.retired]
    );
    // Project Creator refuses to start without a verified catalog entry, including explicit empty ones.
    await client.query(
      `insert into core.task_attachment_catalog (task_record_id, source_base_id, source_table_id, source_field_id, source_snapshot, attachment_files)
       values ($1, 'hawley', 'task_definition_versions', 'attachment_files_json', $2, $3::jsonb)
       on conflict (task_record_id) do update set attachment_files = excluded.attachment_files, source_snapshot = excluded.source_snapshot, imported_at = now()`,
      [v.task_definition_id, `version ${v.version_number}`, JSON.stringify(v.attachment_files_json || [])]
    );
    await client.query(`update hb.task_definitions set current_version_number = $2 where task_definition_id = $1`, [v.task_definition_id, v.version_number]);
  }
  return due.rows.map(v => v.task_definition_id);
}
