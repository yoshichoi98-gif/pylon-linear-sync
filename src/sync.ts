import { Env, destructiveOn } from "./config";
import {
  listProjects, getProject, projectFieldValue, listProjectTasks, getTask,
  getMilestoneName, patchTask, pylonUserMaps,
} from "./pylon";
import {
  teamStateIds, linearUserMaps, existingProjectMilestones, createMilestone,
  createIssue, updateIssue, gql, listProjectsLite, LinearIssueInput,
  getProjectLeadMembers, setProjectLeadMembers,
} from "./linear";
import { getMapping, getMappingByLinear, mappingsForProject, upsertMapping, setHash } from "./db";
import {
  contentHash, pylonStatusToLinearType, linearTypeToPylonStatus,
  pylonAssigneeIdentity, linearAssigneeIdentity, assigneeKey,
  forwardAssigneeWrite, reverseAssigneeWrite,
} from "./map";

const nowISO = () => new Date().toISOString();
// Cap external writes per cron run so a large first-sync can't blow Cloudflare's subrequest limit;
// unwritten tasks (no mapping yet) are simply picked up on the next tick. Reads are cheaper but we
// keep the ceiling well under the 1000 (paid) cap to leave room for reads/D1.
const MAX_WRITES_PER_RUN = 300;

interface Budget { n: number; }

// stateId -> workflow type (reverse fallback if the webhook omits data.state.type)
async function teamStateTypeById(env: Env): Promise<Record<string, string>> {
  const d = await gql(env, `query($t:String!){ team(id:$t){ states{ nodes{ id type } } } }`, { t: env.LINEAR_TEAM_ID });
  const m: Record<string, string> = {};
  for (const s of d.team.states.nodes) m[s.id] = s.type;
  return m;
}

// ---------------- FORWARD: Pylon -> Linear (polling) ----------------
export async function pollForward(env: Env, onlyPylonProjectId?: string): Promise<void> {
  const [stateByType, lu, pu] = await Promise.all([teamStateIds(env), linearUserMaps(env), pylonUserMaps(env)]);
  // Targeted (webhook poke carrying a projectId) syncs just that one project; otherwise (cron) sweeps all.
  const projectIds = onlyPylonProjectId ? [onlyPylonProjectId] : (await listProjects(env)).map((p) => p.id);
  const linProjects = await listProjectsLite(env);

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const resolveLinear = (val: string): string | null => {
    const v = val.trim();
    if (UUID.test(v)) return v;
    let seg = v;
    try {
      // Linear URL: /<workspace>/project/<name>-<slugId>[/<tab>] — take the segment after "project"
      // so a trailing tab like /overview doesn't get mistaken for the slug.
      const parts = new URL(v).pathname.split("/").filter(Boolean);
      const pi = parts.indexOf("project");
      seg = pi >= 0 && parts[pi + 1] ? parts[pi + 1] : parts.pop() || v;
    } catch { /* not a URL */ }
    const slugId = seg.includes("-") ? seg.split("-").pop()! : seg;
    const hit = linProjects.find((p) => p.id === v || p.slugId === slugId || (p.url && p.url.includes(seg)));
    return hit?.id ?? null;
  };

  const budget: Budget = { n: 0 };
  for (const pid of projectIds) {
    if (budget.n >= MAX_WRITES_PER_RUN) { console.log("[fwd] write budget reached — resuming next tick"); break; }
    let proj;
    try { proj = await getProject(env, pid); }
    catch (e) { console.log(`[fwd] getProject ${pid} failed: ${(e as Error).message}`); continue; }
    const raw = projectFieldValue(proj, env.PYLON_SYNC_FIELD_SLUG);
    if (!raw) continue;
    const linearProjectId = resolveLinear(raw);
    if (!linearProjectId) {
      console.log(`[fwd] project ${proj.id}: cannot resolve Linear project from ${JSON.stringify(raw)}`);
      continue;
    }
    // record project pairing only when new/changed (avoid churn every 2 min)
    const existProj = await getMapping(env, proj.id);
    if (!existProj || existProj.linear_id !== linearProjectId) {
      await upsertMapping(env, {
        pylon_id: proj.id, linear_id: linearProjectId, entity_type: "project",
        pylon_parent_id: null, linear_parent_id: null, pylon_project_id: proj.id,
        content_hash: null, last_modified_by: "pylon", last_modified_at: nowISO(), status: "active",
      });
    }
    try {
      const memberIds = new Set(await syncProject(env, proj.id, linearProjectId, stateByType, lu, pu, budget));
      // Linear project lead = Pylon project owner (mapped by email); members = task/subtask assignees.
      const ownerEmail = proj.owner_id ? pu.id2email.get(proj.owner_id) : undefined;
      const leadId = ownerEmail ? lu.email2id.get(ownerEmail) : undefined;
      if (leadId) memberIds.add(leadId); // the lead is also a member
      const cur = await getProjectLeadMembers(env, linearProjectId);
      const curM = new Set(cur.memberIds);
      const membersDiffer = curM.size !== memberIds.size || [...memberIds].some((id) => !curM.has(id));
      const leadDiffer = !!leadId && leadId !== cur.leadId;
      if (membersDiffer || leadDiffer) {
        await setProjectLeadMembers(env, linearProjectId, leadId ?? null, [...memberIds]);
        console.log(`[fwd] project ${proj.id}: lead=${leadId ?? "(unchanged)"} members=${memberIds.size}`);
      }
    } catch (e) {
      console.log(`[pollForward] project ${proj.id} error: ${(e as Error).message}`);
    }
  }
}

async function syncProject(
  env: Env, pylonProjectId: string, linearProjectId: string,
  stateByType: Record<string, string>,
  lu: { id2email: Map<string, string>; email2id: Map<string, string> },
  pu: { id2email: Map<string, string>; email2id: Map<string, string> },
  budget: Budget
): Promise<string[]> {
  const tasks = await listProjectTasks(env, pylonProjectId);
  const existingMs = await existingProjectMilestones(env, linearProjectId); // name -> linear ms id
  const msCache = new Map<string, string>(); // pylon ms id -> linear ms id

  const ensureMs = async (pylonMsId?: string): Promise<string | null> => {
    if (!pylonMsId) return null;
    if (msCache.has(pylonMsId)) return msCache.get(pylonMsId)!;
    const name = await getMilestoneName(env, pylonMsId);
    let lid = existingMs.get(name);
    if (!lid) { lid = await createMilestone(env, linearProjectId, name); budget.n++; existingMs.set(name, lid); }
    msCache.set(pylonMsId, lid);
    await upsertMapping(env, {
      pylon_id: pylonMsId, linear_id: lid, entity_type: "milestone", pylon_parent_id: null,
      linear_parent_id: null, pylon_project_id: pylonProjectId, content_hash: null,
      last_modified_by: "pylon", last_modified_at: nowISO(), status: "active",
    });
    return lid;
  };

  tasks.sort((a, b) => (a.parent_task_id ? 1 : 0) - (b.parent_task_id ? 1 : 0)); // parents first
  const present = new Set<string>();
  const memberIds = new Set<string>(); // Linear user ids of everyone assigned a task/subtask here

  for (const t of tasks) {
    present.add(t.id);
    if (budget.n >= MAX_WRITES_PER_RUN) return [...memberIds]; // stop cleanly; resume next tick

    const idn = pylonAssigneeIdentity(t.assignee, pu.id2email);
    const aw = forwardAssigneeWrite(idn, lu.email2id); // string (matched) | null (none) | undefined (unresolved)
    if (typeof aw === "string") memberIds.add(aw); // collect members for ALL tasks (incl. unchanged)
    const canon = {
      title: t.title, // verbatim
      pylonStatus: t.status,
      milestonePylonId: t.milestone?.id ?? "",
      assigneeKey: assigneeKey(idn),
    };
    const hash = contentHash(canon);
    const map = await getMapping(env, t.id);
    if (map && map.content_hash === hash) continue; // unchanged

    const linearMsId = await ensureMs(t.milestone?.id);
    const stateId = stateByType[pylonStatusToLinearType(t.status)];

    if (!map) {
      const parentMap = t.parent_task_id ? await getMapping(env, t.parent_task_id) : null;
      const input: LinearIssueInput = {
        teamId: env.LINEAR_TEAM_ID, projectId: linearProjectId,
        projectMilestoneId: linearMsId, parentId: parentMap?.linear_id ?? null,
        title: t.title, stateId,
      };
      if (aw !== undefined) input.assigneeId = aw; // else leave unassigned on the new issue
      const issue = await createIssue(env, input); budget.n++;
      await upsertMapping(env, {
        pylon_id: t.id, linear_id: issue.id, entity_type: "task",
        pylon_parent_id: t.parent_task_id ?? null, linear_parent_id: parentMap?.linear_id ?? null,
        pylon_project_id: pylonProjectId, content_hash: hash,
        last_modified_by: "pylon", last_modified_at: nowISO(), status: "active",
      });
      console.log(`[fwd] CREATE ${issue.identifier} ${JSON.stringify(t.title)}`);
    } else {
      // projectId is required alongside projectMilestoneId on update ("milestone without project" error otherwise)
      const input: LinearIssueInput = { title: t.title, stateId, projectId: linearProjectId, projectMilestoneId: linearMsId };
      if (aw !== undefined) input.assigneeId = aw; // omit when unresolved -> don't clobber Linear assignee
      await updateIssue(env, map.linear_id, input); budget.n++;
      await setHash(env, t.id, hash, "pylon", nowISO());
      console.log(`[fwd] UPDATE ${map.linear_id} ${JSON.stringify(t.title)}`);
    }
  }

  // Deletion detection — a mapped task no longer present in Pylon. This pass runs ONLY inside
  // syncProject(), i.e. only for a project whose linear_project_sync_id field is set, so cancels
  // are inherently scoped to synced projects (and it queries only THIS project's mappings).
  const known = await mappingsForProject(env, pylonProjectId); // task mappings for this project
  const activeCount = known.filter((m) => m.status === "active").length;
  // Safety: a 0-task read almost always means a transient/partial Pylon fetch, not "everything was
  // deleted." Never mass-cancel on it. (A truly-emptied project's last task is picked up next poll.)
  if (tasks.length === 0 && activeCount > 0) {
    console.log(`[fwd] skip deletion for ${pylonProjectId}: 0 tasks read but ${activeCount} mapped — treating as transient`);
    return [...memberIds];
  }
  for (const m of known) {
    if (m.status === "active" && !present.has(m.pylon_id)) {
      if (destructiveOn(env)) {
        await updateIssue(env, m.linear_id, { stateId: stateByType["canceled"] }); budget.n++;
        await env.DB.prepare("UPDATE mappings SET status='cancelled' WHERE pylon_id=?").bind(m.pylon_id).run();
        console.log(`[fwd] CANCEL ${m.linear_id} (pylon task ${m.pylon_id} gone)`);
      } else {
        console.log(`[fwd][dry] would cancel ${m.linear_id} (pylon task ${m.pylon_id} gone) — DESTRUCTIVE_OPS=off`);
      }
    }
  }
  return [...memberIds];
}

// ---------------- REVERSE: Linear -> Pylon (webhook) ----------------
export async function handleLinearWebhook(env: Env, payload: any): Promise<void> {
  if (payload.type !== "Issue") return;
  if (payload.action !== "update") return; // create/remove ignored (Pylon-origin only)

  // Fail closed: without a known app actor id we cannot tell our own writes apart -> don't risk loops.
  if (!env.LINEAR_APP_ACTOR_ID) { console.log("[rev] LINEAR_APP_ACTOR_ID unset — skipping (fail closed)"); return; }
  if (payload.actor?.id === env.LINEAR_APP_ACTOR_ID) return; // our own write

  const data = payload.data;
  const map = await getMappingByLinear(env, data.id);
  if (!map || map.entity_type !== "task") return; // not one of our synced issues

  const [lu, pu] = await Promise.all([linearUserMaps(env), pylonUserMaps(env)]);
  // Prefer the type carried in the payload; fall back to a team-scoped lookup only if absent.
  let stateType: string | undefined = data.state?.type;
  if (!stateType) stateType = (await teamStateTypeById(env))[data.stateId];
  const targetStatus = linearTypeToPylonStatus(stateType ?? "unstarted");

  const idn = linearAssigneeIdentity(data.assigneeId, data.assignee?.email, lu.id2email);
  const cur = await getTask(env, map.pylon_id);

  const canon = {
    title: data.title ?? cur.title,
    pylonStatus: targetStatus,
    milestonePylonId: cur.milestone?.id ?? "", // milestone reverse not synced in v1
    assigneeKey: assigneeKey(idn),
  };
  const hash = contentHash(canon);
  if (hash === map.content_hash) return; // already in sync (echo / no-op)

  const body: Record<string, unknown> = {};
  if (data.title != null && data.title !== cur.title) body.title = data.title;
  if (targetStatus !== cur.status) body.status = targetStatus;
  const aw = reverseAssigneeWrite(idn, pu.email2id); // pylon id | "" (clear) | undefined (leave)
  if (aw !== undefined) {
    const curAssignee = cur.assignee?.user?.id ?? "";
    if (aw !== curAssignee) body.assignee_id = aw;
  }
  if (Object.keys(body).length) {
    await patchTask(env, map.pylon_id, body);
    console.log(`[rev] PUSH->Pylon ${map.pylon_id} ${Object.keys(body).join(",")}`);
  }
  await setHash(env, map.pylon_id, hash, "linear", nowISO());
}
