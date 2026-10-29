import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { getDatabaseConfig } from './config.js';
import { pathToFileURL } from 'node:url';

export function prepareTaskAttachmentCatalog(records, uploads) {
  return records.map(record => ({
    task_record_id: record.id,
    attachment_files: (record.fields.fldYIGr0jMmAGfeX6 || []).map(file => {
      const stored = uploads.files[file.id];
      if (!stored?.verified || !stored.sha256 || !stored.key || stored.bytes !== file.size) {
        throw new Error(`Missing or unverified storage for attachment ${file.id}`);
      }
      return {id:file.id, filename:file.filename, type:file.type || 'application/octet-stream',
        size:stored.bytes, bucket:uploads.bucket, key:stored.key, sha256:stored.sha256, verified:true};
    })
  }));
}

async function main() {
  const [snapshot, checkpoint] = process.argv.slice(2);
  if (!snapshot || !checkpoint) throw new Error('Usage: import-task-attachment-catalog.js SNAPSHOT_FOLDER UPLOAD_CHECKPOINT');
  const records = JSON.parse(await fs.readFile(path.join(snapshot,'app0UjzkVuOh7xdi7','tblT6xOuJcsFE23sk','records.json'),'utf8'));
  const uploads = JSON.parse(await fs.readFile(checkpoint,'utf8'));
  const rows = prepareTaskAttachmentCatalog(records, uploads);
  if (!rows.length || !uploads.bucket) throw new Error('Empty catalog or missing bucket');
  const client = new pg.Client(getDatabaseConfig({useSyncUrl:true}));
  await client.connect();
  try {
    await client.query('begin');
    // Do not replace other native catalog entries or remove historical records.
    await client.query(`
      insert into core.task_attachment_catalog
        (task_record_id,source_base_id,source_table_id,source_field_id,source_snapshot,attachment_files)
      select x.task_record_id,'app0UjzkVuOh7xdi7','tblT6xOuJcsFE23sk','fldYIGr0jMmAGfeX6',$2,x.attachment_files
      from jsonb_to_recordset($1::jsonb) as x(task_record_id text, attachment_files jsonb)
      on conflict (task_record_id) do update set attachment_files=excluded.attachment_files,
        source_snapshot=excluded.source_snapshot, imported_at=now()
    `,[JSON.stringify(rows),path.basename(path.resolve(snapshot))]);
    await client.query('commit');
    console.log(JSON.stringify({tasks:rows.length,attachments:rows.reduce((n,r)=>n+r.attachment_files.length,0)}));
  } catch (error) { await client.query('rollback'); throw error; }
  finally { await client.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error(error.message);process.exitCode=1;
});
