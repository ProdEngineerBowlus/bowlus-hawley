import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function preparePlanningImport({ baseId, schema, recordsByTable, dayblocks }) {
  const tasksTable = schema.tables.find(t => t.name === 'Tasks');
  if (!tasksTable || !recordsByTable[tasksTable.id]) throw new Error('Tasks schema and records required');
  const nameField = tasksTable.fields.find(f => f.name === 'Task Name');
  const templates = recordsByTable[tasksTable.id].map(record => {
    const definition = Object.fromEntries(tasksTable.fields.map(f => [f.name, { fieldId: f.id, type: f.type, value: record.fields[f.id] ?? null, options: f.options ?? null }]));
    return { taskId: `airtable:${baseId}:${record.id}`, sourceId: record.id,
      name: record.fields[nameField.id] || record.id, definition, version: digest(definition) };
  });
  const bySource = new Map(templates.map(t => [t.sourceId,t]));
  if (bySource.size !== templates.length) throw new Error('Duplicate template source IDs');
  const byId = new Map(dayblocks.tasks.map(t => [t.gid,t]));
  if (byId.size !== dayblocks.tasks.length) throw new Error('Duplicate Asana source IDs');
  const warnings = [];
  function context(task, visited = new Set()) {
    if (visited.has(task.gid)) throw new Error('Cycle in Asana parent hierarchy');
    visited.add(task.gid);
    const parentId = task.parent?.gid;
    if (parentId && !byId.has(parentId)) throw new Error(`Missing parent ${parentId}`);
    const inherited = parentId ? context(byId.get(parentId), visited) : {};
    const section = task.memberships?.find(m => m.project?.gid === dayblocks.projectId)?.section;
    const day = /^Day\s+(\d+)$/i.exec(task.name.trim());
    return { section: section || inherited.section, day: day ? Number(day[1]) : inherited.day ?? null };
  }
  const nodes = dayblocks.tasks.map((task, position) => {
    const key = task.custom_fields?.find(f => f.name === 'TasksKey')?.display_value?.trim();
    const template = bySource.get(key);
    const ctx = context(task);
    const isDay = /^Day\s+\d+$/i.test(task.name.trim());
    const children = dayblocks.tasks.some(t => t.parent?.gid === task.gid);
    if (key && !template) warnings.push({ sourceId: task.gid, reason: 'TasksKey not found', key });
    if (!ctx.section) warnings.push({ sourceId: task.gid, reason: 'Missing project section' });
    if (!isDay && !template) warnings.push({ sourceId: task.gid, reason: 'No exact template mapping; review required' });
    return { sourceId: task.gid, parentId: task.parent?.gid ?? null, taskId: template?.taskId ?? null,
      name: task.name, sectionId: ctx.section?.gid ?? null, sectionName: ctx.section?.name ?? null,
      day: ctx.day, kind: isDay ? 'day_group' : !template ? 'unmapped' : children ? 'work_group' : 'work_item', position, source: task };
  });
  const schedules = schema.tables.filter(t => ['Cycles','Production','Phases','VINs','Models'].includes(t.name))
    .flatMap(t => { if (!recordsByTable[t.id]) throw new Error(`Missing ${t.name} source records`); return recordsByTable[t.id].map(r => ({ tableId: t.id, tableName: t.name, ...r })); });
  return { baseId, capturedAt: dayblocks.capturedAt, projectId: dayblocks.projectId,
    snapshotHash: digest(dayblocks.tasks), templates, nodes, schedules, warnings };
}

export async function importPlanning(db, bundle) {
  // Dedicated prototype tables only. All changes roll back together on failure.
  await db.query('begin');
  try {
    for (const t of bundle.templates) {
      await db.query('insert into planning_v2.task_definitions values ($1,$2,$3) on conflict do nothing',[t.taskId,bundle.baseId,t.sourceId]);
      await db.query('insert into planning_v2.task_versions values ($1,$2,$3,$4,$5) on conflict do nothing',[t.taskId,t.version,t.name,JSON.stringify(t.definition),bundle.capturedAt]);
      await db.query('insert into planning_v2.template_catalog values ($1,$2) on conflict(task_id) do update set version_hash=excluded.version_hash',[t.taskId,t.version]);
    }
    await db.query('insert into planning_v2.route_sources values ($1,$2,$3) on conflict do nothing',[bundle.projectId,bundle.snapshotHash,bundle.capturedAt]);
    for (const r of bundle.nodes) await db.query('insert into planning_v2.route_nodes values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing',
      [bundle.projectId,bundle.snapshotHash,r.sourceId,r.parentId,r.taskId,r.name,r.sectionId,r.sectionName,r.day,r.kind,r.position,JSON.stringify(r.source)]);
    for (const r of bundle.schedules) await db.query('insert into planning_v2.schedule_sources values ($1,$2,$3,$4,$5) on conflict do nothing',[bundle.baseId,r.tableId,r.id,r.tableName,JSON.stringify(r.fields)]);
    await db.query('commit');
  } catch(e) { await db.query('rollback'); throw e; }
  return { templates:bundle.templates.length,routeNodes:bundle.nodes.length,scheduleRows:bundle.schedules.length,warnings:bundle.warnings };
}
