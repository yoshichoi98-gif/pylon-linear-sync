import { Env } from "./config";
import { verifySignature } from "./linear";
import { hashString } from "./map";
import { hasDelivery, markDelivered, pruneDedup } from "./db";
import { pollForward, handleLinearWebhook } from "./sync";
import { getTask } from "./pylon";

const nowISO = () => new Date().toISOString();

export default {
  // Inbound Linear webhooks (reverse direction), a manual poll trigger, and a health check.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Manual poll trigger for testing (disabled unless MANUAL_TRIGGER_KEY is set).
    if (request.method === "GET" && url.pathname === "/run") {
      if (!env.MANUAL_TRIGGER_KEY || url.searchParams.get("key") !== env.MANUAL_TRIGGER_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      try { await pollForward(env); return new Response("poll complete\n", { status: 200 }); }
      catch (e) { return new Response("poll error: " + (e as Error).message, { status: 500 }); }
    }

    // Pylon "poke" webhook: a Pylon Trigger (e.g. Task status changed) hits this to run the sync
    // immediately instead of waiting for cron. Body is ignored — it just triggers a poll.
    if (request.method === "POST" && url.pathname === "/webhooks/pylon") {
      if (!env.PYLON_WEBHOOK_SECRET || request.headers.get("x-sync-secret") !== env.PYLON_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const rawBody = await request.text();
      // Resolve which project to sync from the body: a projectId directly, or a taskId we look up.
      // If neither is present/resolvable, fall back to a full sweep (still correct, just broader).
      let targetProjectId: string | undefined;
      try {
        const b: any = JSON.parse(rawBody || "{}");
        const pid = b.projectId || b.project_id || b.projectID;
        const tid = b.taskId || b.task_id || b.taskID;
        if (typeof pid === "string" && pid) targetProjectId = pid;
        else if (typeof tid === "string" && tid) {
          try { targetProjectId = (await getTask(env, tid)).project?.id; } catch { /* fall back to full */ }
        }
      } catch { /* no/invalid body → full sweep */ }
      ctx.waitUntil(pollForward(env, targetProjectId).catch((e) => console.log(`[pylon-webhook] ${(e as Error).message}`)));
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === env.WEBHOOK_PATH) {
      const raw = await request.text();
      const sig = request.headers.get("linear-signature") || "";
      if (!(await verifySignature(env.LINEAR_WEBHOOK_SECRET, raw, sig))) {
        return new Response("bad signature", { status: 401 });
      }
      let payload: any;
      try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

      // replay guard (Linear webhookTimestamp is ms)
      if (typeof payload.webhookTimestamp === "number" && Math.abs(Date.now() - payload.webhookTimestamp) > 60_000) {
        return new Response("stale", { status: 400 });
      }

      // stable delivery id: header, else webhookId:ts, else a hash of the raw body (never "undefined:undefined")
      const delivery =
        request.headers.get("linear-delivery") ||
        (payload.webhookId && payload.webhookTimestamp
          ? `${payload.webhookId}:${payload.webhookTimestamp}`
          : `raw:${hashString(raw)}`);

      if (await hasDelivery(env, delivery)) return new Response("dup", { status: 200 });

      // Process before acking so a transient failure returns non-2xx and Linear retries; only mark
      // the delivery processed on success (otherwise a retry would be wrongly deduped away).
      try {
        await handleLinearWebhook(env, payload);
        await markDelivered(env, delivery, nowISO());
        return new Response("ok", { status: 200 });
      } catch (e) {
        console.log(`[webhook] error (will retry): ${(e as Error).message}`);
        return new Response("processing error", { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },

  // Cron: poll Pylon -> Linear, then prune old webhook-dedup rows (replay window is only 60s).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try { await pollForward(env); } catch (e) { console.log(`[cron] poll error: ${(e as Error).message}`); }
        try { await pruneDedup(env, new Date(Date.now() - 86_400_000).toISOString()); } catch { /* best-effort */ }
      })()
    );
  },
};
