export interface Env {
  DB: D1Database;
  // secrets
  PYLON_API_TOKEN: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  // vars
  LINEAR_TEAM_ID: string;
  PYLON_SYNC_FIELD_SLUG: string;
  LINEAR_APP_ACTOR_ID: string;
  DESTRUCTIVE_OPS: string; // "on" | "off"
  WEBHOOK_PATH: string;
  MANUAL_TRIGGER_KEY?: string; // optional secret; enables GET /run?key=... to poll on demand
  PYLON_WEBHOOK_SECRET?: string; // shared secret for the Pylon trigger "poke" webhook (X-Sync-Secret header)
}

export const PYLON_BASE = "https://api.usepylon.com";
export const LINEAR_GQL = "https://api.linear.app/graphql";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

// Pylon task status (3-state) -> desired Linear workflow-state TYPE.
// We resolve TYPE -> concrete stateId per team at runtime (no hardcoded ids).
export const PYLON_STATUS_TO_LINEAR_TYPE: Record<string, string> = {
  not_started: "unstarted", // "Todo"
  in_progress: "started", // "In Progress"
  completed: "completed", // "Done"
};

// Linear workflow-state TYPE -> Pylon task status.
export const LINEAR_TYPE_TO_PYLON_STATUS: Record<string, string> = {
  triage: "not_started",
  backlog: "not_started",
  unstarted: "not_started",
  started: "in_progress",
  completed: "completed",
  canceled: "completed",
  duplicate: "completed",
};

export const destructiveOn = (env: Env) => env.DESTRUCTIVE_OPS === "on";
