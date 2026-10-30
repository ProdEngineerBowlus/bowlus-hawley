import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHawleyTables } from '../src/build-hb.js';

function fixture(asanaRows = []) {
  const calls=[];
  const tables={
    'hb.work_force':[{workforce_record_id:'worker-1',worker_name:'Worker',worker_email:'worker@example.test',efficiency_factor:0.83}],
    'hb.cycles':[{cycle_record_id:'cycle-1',cycle_number:1,cycle_label:'C1.25',start_date:'2025-01-02',end_date:'2025-01-03',days_in_cycle:2,cycle_percent:1}],
    'hb.phases':[{phase_record_id:'phase-1',phase_name:'B',section_column:'B'}],
    'hb.models':[],
    'hb.rev1_task_instances':[{rev1_task_instance_id:77,airtable_record_id:'legacy-77',source_system:'airtable_bootstrap',asana_task_gid:'task-1',task_name:'Original',worker_record_id:'worker-1',worker_name:'Worker',worker_email:'worker@example.test',phase_record_id:'phase-1',phase_label:'B',cycle_record_id:'cycle-1',cycle_label:'C1.25',quantity:1,allocated_hours:2,fields_json:{retained:'history'}}]
  };
  return {calls,tables,client:{async query(sql,params){
    calls.push({sql,params});
    if (/raw\.airtable|delete from/i.test(sql)) throw new Error('Forbidden legacy read or deletion');
    const table=/^select \* from (hb\.\w+)$/.exec(sql)?.[1];
    if(table)return {rows:structuredClone(tables[table])};
    if(sql.includes('from raw.asana_tasks'))return {rows:asanaRows};
    return {rows:[]};
  }}};
}
test('native rebuild preserves unmatched history and never imports cached Airtable values or actuals',async()=>{
  const f=fixture();const before=structuredClone(f.tables);const result=await normalizeHawleyTables(f.client);
  assert.equal(result.retainedTaskInstances,1);assert.equal(result.asanaUpdated,0);assert.equal(result.airtableReads,0);
  assert.deepEqual(f.tables,before);
  assert.equal(f.calls.filter(c=>/update|insert|delete/i.test(c.sql)).length,0);
});
test('Asana completion updates the existing task identity without touching reference data or time history',async()=>{
  const f=fixture([{gid:'task-1',name:'Updated',completed:true,completed_at:'2025-01-03T18:00:00Z',assignee_email:'worker@example.test',assignee_name:'Worker',custom_fields_json:[],raw_json:{},synced_at:'2025-01-03T18:00:00Z'}]);
  const result=await normalizeHawleyTables(f.client);assert.equal(result.asanaUpdated,1);assert.equal(result.asanaAdded,0);
  const updates=f.calls.filter(c=>c.sql.startsWith('update hb.rev1_task_instances'));
  assert.equal(updates.length,1);const [row]=JSON.parse(updates[0].params[0]);assert.equal(row.rev1_task_instance_id,77);assert.equal(row.task_completed,true);assert.equal(row.task_name,'Updated');
  assert.ok(!f.calls.some(c=>/update hb\.(work_force|task_templates)|worker_daily_task_actuals|core.time_sessions/.test(c.sql)));
});
test('empty reference data fails closed rather than restoring an Airtable bootstrap',async()=>{
  const f=fixture();f.tables['hb.work_force']=[];await assert.rejects(normalizeHawleyTables(f.client),/must be populated/);
});
test('clearing Asana Assigned On takes an open task off the worker page only after Hawley saw a date',async()=>{
  const assignedOn=value=>[{gid:'local-assigned-on',name:'Assigned On',display_value:value,date_value:value?{date:value}:null}];
  const run=async(row,asana)=>{
    const f=fixture([{gid:'task-1',name:'Peel Plastic',completed:false,assignee_email:'worker@example.test',assignee_name:'Worker',custom_fields_json:[],raw_json:{},synced_at:'2026-10-30T21:00:00Z',...asana}]);
    Object.assign(f.tables['hb.rev1_task_instances'][0],row);
    await normalizeHawleyTables(f.client);
    const update=f.calls.find(c=>c.sql.startsWith('update hb.rev1_task_instances'));
    return update?JSON.parse(update.params[0])[0]:null;
  };
  let row=await run({assigned_on:'2026-10-29'},{custom_fields_json:assignedOn('2026-10-30')});
  assert.deepEqual([row.assigned_on,row.asana_assigned_on],['2026-10-30','2026-10-30'],'Asana date is dispatched and remembered');
  row=await run({assigned_on:'2026-10-30',asana_assigned_on:'2026-10-30'},{custom_fields_json:assignedOn(null)});
  assert.deepEqual([row.assigned_on,row.asana_assigned_on],[null,null],'cleared in Asana: off the worker page');
  row=await run({assigned_on:'2026-10-30'},{custom_fields_json:[]});
  assert.equal(row.assigned_on,'2026-10-30','never dispatched in Asana: planned date kept');
  row=await run({assigned_on:'2026-10-30',asana_assigned_on:'2026-10-30'},{completed:true,completed_at:'2026-10-30T20:00:00Z',custom_fields_json:assignedOn(null)});
  assert.equal(row.assigned_on,'2026-10-30','completed history keeps its date');
});
