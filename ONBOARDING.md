# Hawley App Onboarding

Hawley is Bowlus's planning system and the record of what happened. Asana runs the day-to-day shop work, and Hawley creates and releases that work into Asana. Hawley is being moved off Airtable, but **Airtable has not been approved for cancellation**.

## Ground rules
- **Never put credential values** in docs, GitHub, commits or agent messages. Don't print or upload secret files either.
- Sign in the normal way. Never pull tokens out of browser sessions.
- Don't reset old checkouts that have uncommitted work, overwrite backups, turn Airtable jobs back on, cancel accounts, or delete history to save time.
- Don't create work that workers can see without a controlled test plan.
- Production writes need one owner at a time.
- PRs merge only after Jacob says "Allowed, merge it".
- Keep replies short, 2–3 sentences.

## Getting set up to make changes
1. Clone `https://github.com/ProdEngineerBowlus/bowlus-hawley` to `C:\dev\bowlus-hawley` and run `npm install`.
2. Sign the GitHub CLI in to the shared Bowlus account (ProdEngineerBowlus) with `gh auth login` in a browser. Get the sign-in details from Jacob in person, never in chat or a file.
3. For deploy logs and read-only DB checks, run `doctl auth init` with your own DigitalOcean team access. Ask Jacob for an invite.
4. Work on a branch and open a PR. Pushing to `main` deploys to production right away, so only merge after Jacob says "Allowed, merge it".
5. One person runs production writes at a time. Tell Jacob before you release or change live data.

## Repo and deploy
- Repo: `C:\dev\bowlus-hawley`. It's Node ESM.
  - Run the tests with `npm test`, which uses node --test plus PGlite for the embedded-Postgres checks. 93 tests pass.
- Every push to `main` deploys to DigitalOcean App Platform. On startup the app applies any new `db/migrations` once, then re-applies `db/views`. See `docs/runbooks/digitalocean-app-platform.md`.
- For read-only DB checks, connect as the `bowlus_readonly` user. Get the connection details through `doctl`.
  - That user can't read the `raw`, `core` or `sync` schemas.
- Main code:
  - `apps/hawley-worker-page/server.js`: the worker page, admin API and background jobs.
  - `apps/hawley-worker-page/public/admin.js`: the admin UI.
  - `apps/hawley-worker-page/phase-release.js`: release logic, with no side effects (pure).
  - `apps/hawley-worker-page/handoffs.js`: handoff logic, also pure.
  - `apps/postgres-sync/src`: Asana pulls and the HB build.

## How work is released now (Admin → Releases tab)
- Asana portfolios:
  - VINs - 2026
  - Fabrication - 2026
  - Frames - 2026
  - CNC - 2026
- How cycle C21.26 and later are split:

| Work | Goes to |
|---|---|
| Frame-A/B, plus the pilot VINs' A1/A2 | FR21.26, FR22.26, … (Frames) |
| CNC-A/B | CNC21.26, … (CNC) |
| FAB-A/B only | F21.26, F22.26, … (Fabrication; a full project every cycle, not just-in-time) |
| Phases B–H | The VIN project, after the Frames gate passes |

- **Automatic release** runs every 10 minutes. It releases each cycle's projects 2 working days before the cycle starts. You switch it on in the Releases tab.
- **Frames gate:**
  - It passes on its own once all of a VIN's A1/A2 tasks are complete. An admin can also pass it with "Pass anyway…" and a reason.
  - When it passes, the A1/A2 tasks move into the VIN project and the next phase is released.
  - The wiring for checklists is in place, but the checklists aren't used yet.
- **Workflow settings** (on the Releases tab): turn each stage on or off and set the cycle it starts from. Frames and CNC both start at C21.26.
- Project Creator is still there as "Project Creator (old)". The Releases tab replaces it.

## Workflow model (planned)
- Departments hand work to each other through gates: Frames → Installation → SOQS (Service, Options, Q.C., Shipping) → storage or sold.
- Gates are meant to be physical handoffs where someone checks the contents:
  - CNC carts (some parts are cannibalized)
  - Cycle boxes (purchased items)
  - Phase carts (worked parts plus QC)
- The handoff engine is built (migration 051 and the Handoffs tab), but every handoff type is still switched off.
- GitHub issue #49 has the build plan. Step 3 is on hold until Jacob gives the go-ahead. It covers:
  - Filling CNC cart contents from `hb.cnc_parts_master`
  - Tablet screens to pack and receive carts
  - Creating a remake task when something is short

## Open items
- Who passes each gate, and what goes on the gate checklists.
- The 2027 portfolios have to exist before year end. Portfolio names are currently hard-coded as "- 2026".
- The worker-assignments query takes 3–7 seconds. Speeding it up is optional.
- Asana Cycle and Airtable reconciliation is still outstanding.

## Helpful runbooks
- `docs/runbooks/hawley-admin-operations.md`
- `docs/runbooks/hawley-worker-page-pilot.md`
- `docs/runbooks/source-boundaries.md`
- `docs/hawley-database-schema.md`
