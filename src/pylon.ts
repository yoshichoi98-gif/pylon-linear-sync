import { Env, PYLON_BASE } from "./config";

async function pylonFetch(env: Env, path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(PYLON_BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.PYLON_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Pylon ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export interface PylonTask {
  id: string;
  title: string;
  body_html?: string;
  status: string;
  updated_at: string;
  assignee?: { user?: { id: string }; contact?: { id: string; email?: string } };
  milestone?: { id: string };
  project?: { id: string };
  parent_task_id?: string;
  subtask_ids?: string[];
  custom_fields?: Record<string, any>;
}

export interface PylonProject {
  id: string;
  name: string;
  description_html?: string;
  custom_fields?: Record<string, any>;
  account?: { id: string };
  owner_id?: string;
}

export async function listProjects(env: Env): Promise<PylonProject[]> {
  const out: PylonProject[] = [];
  let cursor: string | undefined;
  do {
    const body: any = { limit: 100 };
    if (cursor) body.cursor = cursor;
    const r = await pylonFetch(env, "/projects/search", "POST", body);
    for (const p of r.data ?? []) out.push(p);
    cursor = r.pagination?.has_next_page ? r.pagination?.cursor : undefined;
  } while (cursor);
  return out;
}

export async function getProject(env: Env, id: string): Promise<PylonProject> {
  return (await pylonFetch(env, `/projects/${id}`)).data;
}

// Read a project custom-field value by slug. Reads come back as a map; value may be a
// bare string or an object {value}. Returns "" when unset.
export function projectFieldValue(p: PylonProject, slug: string): string {
  const cf = p.custom_fields || {};
  const v = cf[slug];
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v.value ?? v.values?.[0] ?? "").trim();
  return String(v).trim();
}

// All tasks in a project (cursor-paginated). NOTE: GET /tasks?project_id= does NOT filter — must use search.
export async function listProjectTasks(env: Env, projectId: string): Promise<PylonTask[]> {
  const out: PylonTask[] = [];
  let cursor: string | undefined;
  do {
    const body: any = {
      filter: { field: "project_id", operator: "equals", value: projectId },
      limit: 100,
    };
    if (cursor) body.cursor = cursor;
    const r = await pylonFetch(env, "/tasks/search", "POST", body);
    for (const t of r.data ?? []) out.push(t); // empty result omits `data` entirely
    cursor = r.pagination?.has_next_page ? r.pagination?.cursor : undefined;
  } while (cursor);
  return out;
}

export async function getTask(env: Env, id: string): Promise<PylonTask> {
  return (await pylonFetch(env, `/tasks/${id}`)).data;
}

export async function getMilestoneName(env: Env, id: string): Promise<string> {
  return (await pylonFetch(env, `/milestones/${id}`)).data.name;
}

// PATCH a task. Pass assignee_id:"" to clear. custom_fields is an ARRAY of {slug,value} on write.
export async function patchTask(env: Env, id: string, body: Record<string, unknown>): Promise<void> {
  await pylonFetch(env, `/tasks/${id}`, "PATCH", body);
}

// Pylon assignee payload carries only user.id (no email) -> build id->email + email->id.
export async function pylonUserMaps(env: Env): Promise<{ id2email: Map<string, string>; email2id: Map<string, string> }> {
  const r = await pylonFetch(env, "/users?limit=250");
  const id2email = new Map<string, string>();
  const email2id = new Map<string, string>();
  for (const u of r.data ?? []) {
    if (u.email) {
      id2email.set(u.id, u.email.toLowerCase());
      email2id.set(u.email.toLowerCase(), u.id);
    }
  }
  return { id2email, email2id };
}
