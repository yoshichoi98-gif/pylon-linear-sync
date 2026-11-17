# Pylon ↔ Linear Sync

A two-way sync between our customer project tool (Pylon) and our engineering issue tracker (Linear). Customer-facing teams plan rollout work in Pylon, engineers work in Linear, and both see the same tasks and statuses.

## Why I built it

Customer rollouts needed engineering work, but the two teams lived in different tools. Status updates were passed along by hand, so the customer team often didn't know what engineering had finished, and engineers didn't see new customer tasks until someone told them.

## What it does

- **Opt in per project:** a Pylon project syncs once someone sets a custom field to the matching Linear project's ID. Clearing the field turns syncing off.
- **Mapping:** Pylon tasks become Linear issues, subtasks become sub-issues, and milestones become project milestones.
- **Two-way fields:** title, status and assignee (matched by email) update in both directions.
- **Safe by default:** deletions are switched off. A task that vanishes in Pylon is only logged as "would cancel" until deletions are deliberately turned on.

## How it works

```
Pylon --(polled every few minutes)--> Worker --> Linear
Linear --(signed webhook)-----------> Worker --> Pylon
                                        |
                                        +--> D1: ID mapping + content hashes
```

Pylon doesn't send webhooks for tasks, so that direction is polled. Linear sends signed webhooks, so that direction is near real time.

## Engineering decisions

- **No echo loops.** Writes to Linear are made as a dedicated OAuth app, so webhooks caused by the sync's own writes are recognized and dropped. A content hash is the backstop: if nothing really changed, nothing is written.
- **Big projects fill in gradually.** The first sync of a large project is capped per run and finishes over several runs, which keeps each run under Cloudflare's request limits.
- **Honest about limits.** Conflicts are resolved by event order plus the content hash rather than strict timestamps, and milestones sync one way only. Both trade-offs are documented below rather than hidden.

## Known limitations

- A truly simultaneous edit of the same field on both sides between polls can resolve to the later event rather than the later timestamp.
- No per-issue lock; the content hash makes a second near-simultaneous webhook a no-op in the common case.
- Milestones sync from Pylon to Linear only.
- Priority isn't synced until Pylon has a priority field.

## Stack

TypeScript, Cloudflare Workers (cron + webhooks + D1), Pylon API, Linear GraphQL API with OAuth `client_credentials`.

## Layout

- `src/index.ts`: cron entry and the Linear webhook route
- `src/sync.ts`: both sync directions
- `src/map.ts`: field mapping between the two tools
- `src/pylon.ts`, `src/linear.ts`: API clients
- `src/db.ts`, `schema.sql`: ID mapping and hashes

## Running it

`npm install`, create the D1 database and run `npm run db:init:remote`, set `PYLON_API_TOKEN`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` with `wrangler secret put`, then `npm run deploy`. Register a Linear webhook pointing at `/webhooks/linear`.

---

Built at Alleviate Health. Company names, people, IDs and URLs in this public copy are placeholders.
