import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAttachmentsFromStorage, createAttachmentUrlProvider } from '../attachment-storage.js';

test('missing task catalog fails before project creation, including tasks with stale empty data', async () => {
  await assert.rejects(taskAttachmentsFromStorage({query:async()=>({rows:[]})}, [{task_record_id:'rec1',attachment_files_json:[]}]), /incomplete/);
});
test('explicit empty entries are valid, verified files preserve stable references', async () => {
  const file={bucket:'bucket',key:'airtable/attachments/id/hash',sha256:'hash',verified:true};
  const result=await taskAttachmentsFromStorage({query:async()=>({rows:[{task_record_id:'one',attachment_files:[]},{task_record_id:'two',attachment_files:[file]}]})},[{task_record_id:'one'},{task_record_id:'two'}]);
  assert.deepEqual(result.get('one'),[]);assert.deepEqual(result.get('two'),[file]);
});
test('unverified objects fail closed', async () => {
  await assert.rejects(taskAttachmentsFromStorage({query:async()=>({rows:[{task_record_id:'one',attachment_files:[{bucket:'bucket',key:'key'}]}]})},[{task_record_id:'one'}]), /Unverified/);
});
test('URL provider rejects unconfigured storage and foreign buckets', async () => {
  await assert.rejects(createAttachmentUrlProvider({})({}), /not configured/);
  const provider=createAttachmentUrlProvider({HAWLEY_SPACES_ACCESS_KEY:'test',HAWLEY_SPACES_SECRET_KEY:'test',HAWLEY_SPACES_BUCKET:'allowed',HAWLEY_SPACES_REGION:'sfo3'});
  await assert.rejects(provider({bucket:'other',key:'airtable/attachments/id/hash'}), /outside/);
});
