import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export async function taskAttachmentsFromStorage(db, tasks) {
  const ids = [...new Set(tasks.map(t => t.task_record_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await db.query(`
    select task_record_id, attachment_files
    from core.task_attachment_catalog where task_record_id = any($1::text[])
  `, [ids]);
  const result = new Map(rows.map(row => [row.task_record_id, row.attachment_files]));
  // Explicit empty catalog entries distinguish no attachments from an incomplete import.
  for (const id of ids) {
    if (!result.has(id)) throw new Error(`Attachment catalog is incomplete for task ${id}. Project creation has not started.`);
    for (const file of result.get(id)) {
      if (!file.bucket || !file.key || !file.sha256 || !file.verified) {
        throw new Error(`Unverified stored attachment for task ${id}. Project creation has not started.`);
      }
    }
  }
  return result;
}

export function createAttachmentUrlProvider(env = process.env) {
  let client;
  return async attachment => {
    if (!env.HAWLEY_SPACES_ACCESS_KEY || !env.HAWLEY_SPACES_SECRET_KEY || !env.HAWLEY_SPACES_BUCKET || !env.HAWLEY_SPACES_REGION) {
      throw new Error('Hawley attachment storage is not configured.');
    }
    if (attachment.bucket !== env.HAWLEY_SPACES_BUCKET || !attachment.key?.startsWith('airtable/attachments/')) {
      throw new Error('Attachment is outside the configured private storage.');
    }
    client ||= new S3Client({
      region: env.HAWLEY_SPACES_REGION,
      endpoint: `https://${env.HAWLEY_SPACES_REGION}.digitaloceanspaces.com`,
      credentials: { accessKeyId: env.HAWLEY_SPACES_ACCESS_KEY, secretAccessKey: env.HAWLEY_SPACES_SECRET_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
    // Generate immediately before download; large project runs can outlive a URL.
    return getSignedUrl(client, new GetObjectCommand({ Bucket: attachment.bucket, Key: attachment.key }), { expiresIn: 900 });
  };
}
