import { createHash } from 'node:crypto';

// Derive authority from the immutable human kickoff, never from the latest
// peer reply or simply from a room having an active work grant.
export async function workAuthorization(sql, roomId, workId, { includeText = false } = {}) {
  const row = await sql.get('SELECT data_json FROM work_sessions WHERE id=? AND room_id=?',[workId,roomId]);
  const work = row ? JSON.parse(row.data_json) : null;
  const source = work && await sql.get('SELECT text,attachment_ids_json FROM deliveries WHERE room_id=? AND work_id=? AND message_id=? ORDER BY id LIMIT 1',
    [roomId,workId,work.sourceHumanMessageId]);
  if (!source) throw Object.assign(new Error('Authorized work source is unavailable'),{code:'WORK_SCOPE_UNAVAILABLE'});
  return {
    workId, sourceHumanMessageId:work.sourceHumanMessageId, objective:work.objective,
    expiresAt:work.expiresAt, textSha256:createHash('sha256').update(source.text,'utf8').digest('hex'),
    attachmentIds:JSON.parse(source.attachment_ids_json),
    ...(includeText ? {text:source.text,...(work._planText?{agreedPlan:{text:work._planText,sha256:work.authority.planSha256,authority:'implementation context only'}}:{})} : {}),
  };
}
