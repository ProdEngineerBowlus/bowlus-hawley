import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTaskAttachmentCatalog } from '../src/import-task-attachment-catalog.js';
test('attachment import preserves filenames and creates explicit empty entries',()=>{
  const result=prepareTaskAttachmentCatalog([{id:'empty',fields:{}},{id:'task',fields:{fldYIGr0jMmAGfeX6:[{id:'att',size:42,filename:'QC.pdf'}]}}],{bucket:'private',files:{att:{verified:true,sha256:'hash',key:'key',bytes:42}}});
  assert.deepEqual(result[0].attachment_files,[]);
  assert.equal(result[1].attachment_files[0].filename,'QC.pdf');
  assert.equal(result[1].attachment_files[0].bucket,'private');
});
test('attachment import rejects missing files and size mismatches before opening database',()=>{
  const records=[{id:'task',fields:{fldYIGr0jMmAGfeX6:[{id:'att',size:42}]}}];
  assert.throws(()=>prepareTaskAttachmentCatalog(records,{files:{}}),/unverified/);
  assert.throws(()=>prepareTaskAttachmentCatalog(records,{files:{att:{verified:true,sha256:'hash',key:'key',bytes:41}}}),/unverified/);
});
