import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { preparePlanningImport, importPlanning } from './planning-v2-import.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output) throw new Error('Usage: node preview-planning-v2.js <export-folder> <new-output-folder>');
await fs.mkdir(output, {recursive:true});
const baseId = 'app0UjzkVuOh7xdi7';
const schema = JSON.parse(await fs.readFile(path.join(snapshot,baseId,'schema.json')));
const recordsByTable = {};
for (const t of schema.tables.filter(t => ['Tasks','Cycles','Production','Phases','VINs','Models'].includes(t.name))) {
  recordsByTable[t.id] = JSON.parse(await fs.readFile(path.join(snapshot,baseId,t.id,'records.json')));
}
const dayblocks = JSON.parse(await fs.readFile(path.join(snapshot,'dayblocks-frontier-full.json')));
const bundle = preparePlanningImport({baseId,schema,recordsByTable,dayblocks});
const db = new PGlite(path.join(output,'postgres-preview'));
try {
  await db.exec(await fs.readFile(path.join(root,'db/prototypes/planning-v2.sql'),'utf8'));
  const result = await importPlanning(db,bundle);
  const counts = await db.query(`select
    (select count(*) from planning_v2.task_definitions)::int as templates,
    (select count(*) from planning_v2.route_nodes)::int as route_nodes,
    (select count(*) from planning_v2.work_occurrences)::int as occurrences`);
  const sections = await db.query(`select section_name, count(*)::int as nodes,
    count(task_id)::int as mapped_nodes, min(approximate_phase_day) as first_day,
    max(approximate_phase_day) as last_day from planning_v2.route_nodes
    where snapshot_hash=$1 group by section_name order by section_name`,[bundle.snapshotHash]);
  const report = {...result,counts:counts.rows[0],sections:sections.rows,sourceCapturedAt:bundle.capturedAt,
    limitations:['Local prototype only; not deployed to DigitalOcean.','Day numbers retained as provisional phase-relative targets.','Parent and child estimates must not be summed without an approved counting rule.','Preserves all Airtable Tasks; DayBlocks is an overlay, not a catalog filter.']};
  await fs.writeFile(path.join(output,'review.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(output,'template-map.json'),JSON.stringify(bundle.templates.map(t=>({taskId:t.taskId,sourceId:t.sourceId,name:t.name,version:t.version})),null,2));
  console.log(JSON.stringify(report));
} finally { await db.close(); }
