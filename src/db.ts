import { Env } from "./config";

export interface Mapping {
  pylon_id: string;
  linear_id: string;
  entity_type: string;
  pylon_parent_id: string | null;
  linear_parent_id: string | null;
  pylon_project_id: string | null;
  content_hash: string | null;
  last_modified_by: string | null;
  last_modified_at: string | null;
  status: string;
}

export async function getMapping(env: Env, pylonId: string): Promise<Mapping | null> {
  return env.DB.prepare("SELECT * FROM mappings WHERE pylon_id = ?").bind(pylonId).first<Mapping>();
}

export async function getMappingByLinear(env: Env, linearId: string): Promise<Mapping | null> {
  return env.DB.prepare("SELECT * FROM mappings WHERE linear_id = ?").bind(linearId).first<Mapping>();
}

export async function mappingsForProject(env: Env, pylonProjectId: string): Promise<Mapping[]> {
  const r = await env.DB.prepare("SELECT * FROM mappings WHERE pylon_project_id = ? AND entity_type='task'")
    .bind(pylonProjectId)
    .all<Mapping>();
  return r.results ?? [];
}

export async function upsertMapping(env: Env, m: Mapping): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mappings
       (pylon_id, linear_id, entity_type, pylon_parent_id, linear_parent_id, pylon_project_id, content_hash, last_modified_by, last_modified_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(pylon_id) DO UPDATE SET
       linear_id=excluded.linear_id, entity_type=excluded.entity_type,
       pylon_parent_id=excluded.pylon_parent_id, linear_parent_id=excluded.linear_parent_id,
       pylon_project_id=excluded.pylon_project_id, content_hash=excluded.content_hash,
       last_modified_by=excluded.last_modified_by, last_modified_at=excluded.last_modified_at,
       status=excluded.status`
  )
    .bind(
      m.pylon_id, m.linear_id, m.entity_type, m.pylon_parent_id, m.linear_parent_id,
      m.pylon_project_id, m.content_hash, m.last_modified_by, m.last_modified_at, m.status
    )
    .run();
}

export async function setHash(env: Env, pylonId: string, hash: string, by: string, at: string): Promise<void> {
  await env.DB.prepare("UPDATE mappings SET content_hash=?, last_modified_by=?, last_modified_at=? WHERE pylon_id=?")
    .bind(hash, by, at, pylonId)
    .run();
}

export async function hasDelivery(env: Env, deliveryId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT delivery_id FROM webhook_dedup WHERE delivery_id=?").bind(deliveryId).first();
  return !!r;
}

// Record a delivery as processed — call ONLY after successful handling so a transient failure retries.
export async function markDelivered(env: Env, deliveryId: string, at: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO webhook_dedup (delivery_id, seen_at) VALUES (?,?)").bind(deliveryId, at).run();
}

export async function pruneDedup(env: Env, olderThanISO: string): Promise<void> {
  await env.DB.prepare("DELETE FROM webhook_dedup WHERE seen_at < ?").bind(olderThanISO).run();
}
