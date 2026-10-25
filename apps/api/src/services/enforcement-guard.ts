import type { Db } from '../db.js';
import { HttpError } from '../http.js';

export async function assertEnforcementClear(db: Db, sessionId: string) {
  const row = (await db.query(
    `select id, unit_id, fine_issued_at, immobilized_at from enforcement_case
     where session_id = $1 and ((unit_id is not null and (fine_issued_at is null or immobilized_at is null)) or (unit_id is null and immobilized_at is null))
     order by created_at desc limit 1`, [sessionId])).rows[0];
  if (!row) return;
  const requiredActions = [
    ...(row.unit_id && !row.fine_issued_at ? ['fine'] : []),
    ...(!row.immobilized_at ? ['immobilization'] : []),
  ];
  throw new HttpError(409, 'enforcement_required', 'Complete the required fine and immobilization actions before checkout', { reportId: row.id, requiredActions });
}
