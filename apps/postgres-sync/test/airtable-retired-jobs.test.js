import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const server=await readFile(new URL('../../hawley-worker-page/server.js',import.meta.url),'utf8');
test('legacy true flags cannot restart retired Airtable runtime jobs',()=>{
 const names=['shouldStartWorkerActualsWatcher','shouldStartAirtableTaskTimeWriteback','shouldStartAirtableCurrentAssignmentsWatcher','shouldRunNightlyAirtableBackfill','nightlyRefreshNeedsAirtable'];
 const env=new Proxy({}, {get:()=> 'true'});
 for(const name of names){const source=server.match(new RegExp('function '+name+'\\(\\) \\{[\\s\\S]*?\\n\\}'))?.[0];assert.ok(source);assert.equal(vm.runInNewContext(source+';'+name+'()',{process:{env},booleanEnv:()=>true}),false,name);}
});
