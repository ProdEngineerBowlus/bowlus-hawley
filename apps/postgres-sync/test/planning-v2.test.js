import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { preparePlanningImport, importPlanning } from '../src/planning-v2-import.js';

function fixture() {
  return {baseId:'base',schema:{tables:[{id:'tasks',name:'Tasks',fields:[{id:'name',name:'Task Name',type:'singleLineText'}]}]},
    recordsByTable:{tasks:[{id:'fab',fields:{name:'FAB outside Frontier'}},{id:'install',fields:{name:'Installation'}}]},
    dayblocks:{projectId:'project',capturedAt:'2026-10-28T00:00:00Z',tasks:[
      {gid:'day',name:'Day 3',memberships:[{project:{gid:'project'},section:{gid:'phase',name:'Phase B'}}]},
      {gid:'job',name:'Install',parent:{gid:'day'},custom_fields:[{name:'TasksKey',display_value:'install'}]},
      {gid:'unknown',name:'Unmatched work',parent:{gid:'day'}}]}};
}
test('complete catalog retained; day containers inherit section/day without becoming work',()=>{
  const b=preparePlanningImport(fixture());
  assert.equal(b.templates.length,2);
  assert.equal(b.nodes[0].kind,'day_group');
  assert.equal(b.nodes[1].day,3);
  assert.equal(b.nodes[1].sectionName,'Phase B');
  assert.equal(b.nodes[2].taskId,null);
  assert.equal(b.warnings.length,1);
});
test('missing or cyclic parents fail before import',()=>{
  const f=fixture();f.dayblocks.tasks[0].parent={gid:'job'};
  assert.throws(()=>preparePlanningImport(f),/Cycle/);
  f.dayblocks.tasks[0].parent={gid:'missing'};
  assert.throws(()=>preparePlanningImport(f),/Missing parent/);
});
test('Postgres import is repeatable, preserves released versions and does not generate work',async()=>{
  const db=new PGlite();
  try {
    await db.exec(await fs.readFile(new URL('../../../db/prototypes/planning-v2.sql',import.meta.url),'utf8'));
    const f=fixture(),b=preparePlanningImport(f);
    await importPlanning(db,b);await importPlanning(db,b);
    assert.equal((await db.query('select * from planning_v2.task_definitions')).rows.length,2);
    assert.equal((await db.query('select * from planning_v2.work_occurrences')).rows.length,0);
    const t=b.templates[1];
    await db.query(`insert into planning_v2.work_occurrences(occurrence_id,task_id,version_hash,subject_kind,subject_id,planned_quantity,current_cycle_id) values('work',$1,$2,'vin','327',1,'C1')`,[t.taskId,t.version]);
    f.recordsByTable.tasks[1].fields.name='Changed instruction version';await importPlanning(db,preparePlanningImport(f));
    await db.query("update planning_v2.work_occurrences set current_cycle_id='C2' where occurrence_id='work'");
    const released=(await db.query('select v.task_name from planning_v2.work_occurrences w join planning_v2.task_versions v using(task_id,version_hash)')).rows[0];
    assert.equal(released.task_name,'Installation');
    assert.equal((await db.query('select * from planning_v2.task_versions')).rows.length,3);
    const bad={...b,nodes:[{...b.nodes[1],sourceId:'bad',parentId:'absent'}]};
    await assert.rejects(importPlanning(db,bad));
    assert.equal((await db.query("select * from planning_v2.route_nodes where source_task_id='bad'")).rows.length,0);
  } finally {await db.close();}
});
