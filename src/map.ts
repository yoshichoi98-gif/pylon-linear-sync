import { LINEAR_TYPE_TO_PYLON_STATUS, PYLON_STATUS_TO_LINEAR_TYPE } from "./config";

export const pylonStatusToLinearType = (s: string) => PYLON_STATUS_TO_LINEAR_TYPE[s] ?? "unstarted";
export const linearTypeToPylonStatus = (t: string) => LINEAR_TYPE_TO_PYLON_STATUS[t] ?? "not_started";

// Direction-agnostic fingerprint of the fields we sync. Both directions normalize to the SAME
// canonical values (title verbatim, Pylon status, Pylon milestone id, and a shared email-based
// assignee key) so an in-sync entity hashes equal on both sides — that's what keeps echo/idempotency
// working. IMPORTANT: title is verbatim (never trim — trailing-space normalization ping-pongs).
export interface Canonical {
  title: string;
  pylonStatus: string; // not_started | in_progress | completed
  milestonePylonId: string; // "" when none
  assigneeKey: string; // shared email (lowercased); "" when none/unresolvable
}

export function contentHash(c: Canonical): string {
  const s = JSON.stringify([c.title, c.pylonStatus, c.milestonePylonId, c.assigneeKey]);
  let h = 0x811c9dc5; // FNV-1a, deterministic
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// Shared assignee identity: whether an assignee is present, and its email (the cross-system key).
export interface AssigneeIdentity { present: boolean; email: string | null; }

export function pylonAssigneeIdentity(
  a: { user?: { id: string }; contact?: { id: string; email?: string } } | undefined,
  pylonId2email: Map<string, string>
): AssigneeIdentity {
  if (!a || (!a.user && !a.contact)) return { present: false, email: null };
  if (a.user?.id) return { present: true, email: pylonId2email.get(a.user.id) ?? null };
  if (a.contact?.email) return { present: true, email: a.contact.email.toLowerCase() };
  return { present: true, email: null };
}

export function linearAssigneeIdentity(
  assigneeId: string | null | undefined,
  assigneeEmail: string | null | undefined,
  linearId2email: Map<string, string>
): AssigneeIdentity {
  if (!assigneeId && !assigneeEmail) return { present: false, email: null };
  const email = (assigneeEmail || (assigneeId ? linearId2email.get(assigneeId) : "") || "").toLowerCase();
  return { present: true, email: email || null };
}

export const assigneeKey = (idn: AssigneeIdentity): string => idn.email ?? "";

// Forward write value for Linear assigneeId: a user id (set), null (clear — Pylon has none),
// or undefined (LEAVE UNTOUCHED — Pylon has an assignee we can't resolve to a Linear user).
export function forwardAssigneeWrite(idn: AssigneeIdentity, linearEmail2id: Map<string, string>): string | null | undefined {
  if (!idn.present) return null;
  if (idn.email && linearEmail2id.has(idn.email)) return linearEmail2id.get(idn.email)!;
  return undefined;
}

// Reverse write value for Pylon assignee_id: a user id (set), "" (clear — Linear has none),
// or undefined (LEAVE UNTOUCHED — Linear has an assignee we can't resolve to a Pylon user).
export function reverseAssigneeWrite(idn: AssigneeIdentity, pylonEmail2id: Map<string, string>): string | undefined {
  if (!idn.present) return "";
  if (idn.email && pylonEmail2id.has(idn.email)) return pylonEmail2id.get(idn.email)!;
  return undefined;
}
