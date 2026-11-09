# NocoDB over Hawley Postgres

NocoDB gives Bowlus people an Airtable-style grid (filters, sorts, grouped views, forms)
over Hawley's Postgres. It is a window onto the data, not a new home for it.

## Boundaries

- Hawley data stays in `bowlus_ops`. NocoDB connects to it as an **external data source**;
  never create NocoDB-managed tables for real data, so leaving NocoDB later means no data
  migration, only rebuilding views.
- NocoDB keeps its own users, bases and view settings in a separate `nocodb_meta`
  database on the same cluster.
- The Hawley connection is **read-only** (`nocodb_reader`). `hb` and `raw` are rebuilt from
  Asana/Airtable by `pg:build:hb` and the pull scripts, so edits there would be overwritten.
  Editable CNC parts need Hawley-owned tables first; grant `nocodb_reader` (or a separate
  `nocodb_editor`) write access to those tables only.
- `core.app_users`, `core.app_sessions` and `core.app_auth_events` are never readable.
- License: from v0.301.0 (2026-01-09) NocoDB is under the Sustainable Use License.
  Self-hosting for internal company use is allowed; offering it to outside customers or as
  a hosted service is not. Re-check https://nocodb.com/docs/self-hosting/license before
  upgrading.

## Setup

### 1. Database users (DigitalOcean control panel)

Databases > `hawley-pg-prod` > Users & Databases:

- add user `nocodb_reader`
- add user `nocodb_meta`
- add database `nocodb_meta`

(Or use `doctl databases user create <db> <name>` and `doctl databases db create <db> nocodb_meta`. These were done on 2026-11-09.)

### 2. Grants

From a trusted machine with the sync/admin URL. On 2026-11-09 these were applied with
`node scripts/hawley-db.mjs admin -- …`.

```powershell
psql $env:HAWLEY_SYNC_DATABASE_URL -f scripts/nocodb-access.sql
```

Then, connected to the `nocodb_meta` database as the admin user:

```sql
grant all privileges on database nocodb_meta to nocodb_meta;
grant usage, create on schema public to nocodb_meta;
```

Re-run `scripts/nocodb-access.sql` after migrations that add tables to `core` or `ops`
(new `hb` and `reporting` tables are picked up by its default privileges when
created by the same user that ran it).

### 3. Deploy the app

Deployed 2026-11-09 as app `daeb8b60-f269-4826-94f4-2ee02e3d421c` (`bowlus-nocodb`).

To recreate it, copy `deploy/nocodb/app.yaml` to a temporary file outside the repo and
replace every `CHANGE_ME` there:

- `NC_DB_JSON`: host and port from `doctl databases connection`, and the `nocodb_meta` password
  from `doctl databases user get <db> nocodb_meta --show`
- `NC_AUTH_JWT_SECRET`: a long random string (`openssl rand -hex 32`). Changing it later
  signs everyone out.

Then run `doctl apps create --spec <temporary file>` and delete the temporary file.

Add the app to the cluster's **Trusted Sources**
(`doctl databases firewalls append <db> --rule app:<app id>`), or it can't connect.

**First login:** there are no admin bootstrap variables, so the first person to sign up
becomes the super admin. Open the app URL and sign up straight after the first deploy.
After that, signup is invite-only.

### 4. Connect Hawley

In NocoDB: create a base (e.g. `Hawley`) > **Connect External Data Source** > PostgreSQL:

- host / port: the cluster's, database `bowlus_ops`, user `nocodb_reader`
- SSL: on, SSL mode **Required**, with the cluster's CA certificate uploaded
  (`doctl databases get-ca <db>`, base64-decoded, or "Download CA certificate" in the
  control panel). Without the CA the test fails with "self-signed certificate in
  certificate chain".
- schema: one per data source (`hb`, `reporting`, ...), adding only what people need

If the test says "Connection to internal hosts is not allowed", the app is missing
`NC_ALLOW_LOCAL_EXTERNAL_DBS=true`. Inside App Platform the cluster host resolves to a
private VPC address, which NocoDB's SSRF guard blocks by default. The spec sets it. Only
invited users with Creator rights can add data sources, and `nocodb_reader` is read-only.

Turn off "Allow schema changes" and "Allow data edits" on the source; the database user
enforces read-only either way.

### 5. Build views

Each table gets a default grid. Add named views on top: filters, sorts, hidden fields,
group-by, kanban, gallery. Views are only saved settings in `nocodb_meta`; they never
change Hawley data.

## Giving other workers access

NocoDB has its own accounts, separate from the Hawley worker-page login.

- **Invite**: base > Share > invite by email, with a role. Without SMTP configured, NocoDB
  shows an invite link to copy and send yourself. To have it email people, add the
  `NC_SMTP_*` variables (from, host, port, username, password) to the app.
- **Roles** (per base):
  | Role | Can |
  |---|---|
  | Owner / Creator | change the base, sources, views and members |
  | Editor | edit records (only where the database user allows writes) |
  | Commenter | read and comment on records |
  | Viewer | read only |
  | No access | nothing |

  Most shop people should be **Viewer** (or **Editor** once the editable CNC tables exist).
  Keep Creator to the few people who build views.
- **Shared view links**: any view can be shared as a read-only link, optionally with a
  password. Anyone with the link can see that one view without an account. Use this for
  a shop-floor screen, not for anything sensitive.
- **Signup is invite-only** (`NC_INVITE_ONLY_SIGNUP=true`), so nobody can create an
  account from the login page.
- **Leaving**: remove the person from the base (Share > members). Removing them from the
  workspace removes all access.

## Upgrades

The image tag is pinned in `deploy/nocodb/app.yaml`. To upgrade, read the release notes
and license page, bump the tag, and redeploy. NocoDB migrates `nocodb_meta` on start;
take a backup of `nocodb_meta` first (DigitalOcean daily backups cover the cluster).
