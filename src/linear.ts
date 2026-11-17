import { Env, LINEAR_GQL, LINEAR_TOKEN_URL } from "./config";

// --- app token via client_credentials (actor=app), cached in the isolate ---
let cachedToken: { value: string; exp: number } | null = null;

export async function linearToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.exp - 60_000) return cachedToken.value;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.LINEAR_CLIENT_ID,
    client_secret: env.LINEAR_CLIENT_SECRET,
    scope: "read,write",
  });
  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Linear token -> ${res.status} ${await res.text()}`);
  const j: any = await res.json();
  cachedToken = { value: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

export async function gql(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const token = await linearToken(env);
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j: any = await res.json();
  if (j.errors) throw new Error("Linear GQL: " + JSON.stringify(j.errors).slice(0, 500));
  return j.data;
}

// team workflow-state TYPE -> concrete stateId (prefer "In Progress" among the two `started`).
export async function teamStateIds(env: Env): Promise<Record<string, string>> {
  const d = await gql(
    env,
    `query($t:String!){ team(id:$t){ states{ nodes{ id name type } } } }`,
    { t: env.LINEAR_TEAM_ID }
  );
  const byType: Record<string, string> = {};
  for (const s of d.team.states.nodes) {
    if (s.type === "started") {
      if (!byType.started || s.name === "In Progress") byType.started = s.id;
    } else if (!byType[s.type]) {
      byType[s.type] = s.id;
    }
  }
  return byType;
}

export async function linearUserMaps(env: Env): Promise<{ id2email: Map<string, string>; email2id: Map<string, string> }> {
  const d = await gql(env, `{ users(first:250){ nodes{ id email active } } }`);
  const id2email = new Map<string, string>();
  const email2id = new Map<string, string>();
  for (const u of d.users.nodes) {
    if (u.active && u.email) {
      id2email.set(u.id, u.email.toLowerCase());
      email2id.set(u.email.toLowerCase(), u.id);
    }
  }
  return { id2email, email2id };
}

export async function listProjectsLite(env: Env): Promise<{ id: string; url: string; slugId: string }[]> {
  const d = await gql(env, `{ projects(first:250){ nodes{ id url slugId } } }`);
  return d.projects.nodes;
}

export async function existingProjectMilestones(env: Env, projectId: string): Promise<Map<string, string>> {
  const d = await gql(
    env,
    `query($p:String!){ project(id:$p){ projectMilestones(first:250){ nodes{ id name } } } }`,
    { p: projectId }
  );
  const byName = new Map<string, string>();
  for (const m of d.project.projectMilestones.nodes) byName.set(m.name, m.id);
  return byName;
}

export async function getProjectLeadMembers(env: Env, projectId: string): Promise<{ leadId: string | null; memberIds: string[] }> {
  const d = await gql(env, `query($id:String!){ project(id:$id){ lead{ id } members{ nodes{ id } } } }`, { id: projectId });
  return { leadId: d.project.lead?.id ?? null, memberIds: (d.project.members?.nodes ?? []).map((m: any) => m.id) };
}

export async function setProjectLeadMembers(env: Env, projectId: string, leadId: string | null, memberIds: string[]): Promise<void> {
  const input: any = { memberIds };
  if (leadId) input.leadId = leadId;
  await gql(env, `mutation($id:String!,$i:ProjectUpdateInput!){ projectUpdate(id:$id,input:$i){ success } }`, { id: projectId, i: input });
}

export async function createMilestone(env: Env, projectId: string, name: string): Promise<string> {
  const d = await gql(
    env,
    `mutation($p:String!,$n:String!){ projectMilestoneCreate(input:{projectId:$p,name:$n}){ projectMilestone{ id } } }`,
    { p: projectId, n: name }
  );
  return d.projectMilestoneCreate.projectMilestone.id;
}

export interface LinearIssueInput {
  teamId?: string;
  projectId?: string;
  projectMilestoneId?: string | null;
  parentId?: string | null;
  title?: string;
  stateId?: string;
  assigneeId?: string | null;
}

export async function createIssue(env: Env, input: LinearIssueInput): Promise<{ id: string; identifier: string }> {
  const d = await gql(
    env,
    `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue{ id identifier } } }`,
    { i: input }
  );
  return d.issueCreate.issue;
}

export async function updateIssue(env: Env, id: string, input: LinearIssueInput): Promise<void> {
  await gql(env, `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success } }`, {
    id,
    i: input,
  });
}

// --- webhook signature (HMAC-SHA256 over RAW body, hex) via Web Crypto ---
export async function computeSignature(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySignature(secret: string, rawBody: string, signatureHex: string): Promise<boolean> {
  const hex = await computeSignature(secret, rawBody);
  if (hex.length !== signatureHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signatureHex.charCodeAt(i);
  return diff === 0;
}
