# StepTrack server

FastAPI + SQLAlchemy 2 + Alembic on Postgres, blobs in S3 (MinIO locally). Implements the sync/API
contract in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md); the generated OpenAPI document is
[`openapi.json`](openapi.json) (input for the TS client types).

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.13, a Postgres 14+ database and an S3 bucket.

```bash
cd server
uv sync                                   # creates .venv with runtime + dev deps
export DATABASE_URL=postgresql://steptrack:steptrack@localhost:5432/steptrack
uv run alembic upgrade head               # create / migrate the schema
uv run python -m app.seed                 # dev users, demo procedure, workstations, tools (idempotent)
uv run uvicorn app.main:app --reload      # http://localhost:8000, docs at /docs
```

Everything (Postgres, MinIO, server, web app) in containers: `docker compose up --build` from the
repo root, then open http://localhost:8080 (the web container proxies `/api/` to the server).

## Configuration

Environment variables (or `server/.env`); see also the root [`.env.example`](../.env.example).

| Variable | Default | |
|---|---|---|
| `ENV` | `development` | `development` \| `test` \| `staging` \| `production` |
| `DATABASE_URL` | `postgresql://steptrack:steptrack@localhost:5432/steptrack` | `postgresql://` is mapped to psycopg 3 |
| `AUTH_MODE` | `dev` | `dev` or `oidc`. **Refused when `ENV=production`.** |
| `OIDC_ISSUER`, `OIDC_AUDIENCE` | — | required for `oidc`; JWKS discovered from the issuer |
| `OIDC_ROLES_CLAIM` | `roles` | dotted paths allowed (`realm_access.roles`); merged with DB roles |
| `OIDC_JWKS_URL` | — | override JWKS discovery |
| `S3_ENDPOINT` | — (AWS) | e.g. `http://localhost:9000` for MinIO (path-style addressing) |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | `steptrack`, —, —, `us-east-1` | |
| `S3_CREATE_BUCKET` | `false` | create the bucket on startup (dev/MinIO) |
| `BLOB_MAX_BYTES` | `26214400` (25 MB) | upload size limit |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:8080` | comma-separated or JSON list |
| `ROOT_PATH` | — | set to `/api` behind a prefix-stripping proxy |
| `LOCK_TTL_SECONDS` / `CHECKOUT_DEFAULT_HOURS` / `CHECKOUT_MAX_HOURS` | `120` / `12` / `72` | §6 |

### Auth

- **dev**: `Authorization: Dev <user-id>`. `GET /auth/dev-users` lists the seeded users
  (operator, inspector, author, approver, supervisor, admin, second operator; PIN `123456` each).
- **oidc**: `Authorization: Bearer <JWT>`, validated against the issuer's JWKS (signature, `iss`, `aud`,
  `exp`). First login provisions a user from `sub`/`name`/`email`; admins can pre-provision users
  (`POST /users`) and add DB roles (`PUT /users/{id}/roles`).

## Endpoints

| | |
|---|---|
| `GET /health` | liveness + DB check |
| `GET /me`, `PUT /me/pin` | current user (roles merged), set offline PIN (6–12 digits) |
| `GET /auth/dev-users` | dev mode only (404 otherwise) |
| `GET/POST /users`, `PUT /users/{id}/roles` | admin |
| `GET/POST /procedures`, `GET /procedures/{id}` | list, create (`{number, title, content?}` → `{procedure, revision}`), detail with revisions |
| `POST /procedures/{id}/revisions` | new draft copying the latest content; `{change_reason}` required |
| `GET /revisions/{id}`, `PUT /revisions/{id}/content` | read; edit draft (`{content, change_reason?}`) |
| `POST /revisions/{id}/submit` \| `approve` \| `reject`, `GET /revisions/{id}/approvals` | state machine §3.1 |
| `POST /sync/push`, `GET /sync/pull?cursor=&limit=` | §7 |
| `PUT/HEAD/GET /blobs/{sha256}` | content-addressed blobs (`sha256:` prefix accepted) |
| `GET /runs`, `GET /runs/{id}`, `/events`, `/projection` | read access; server-side projection for debugging |
| `GET /runs/{id}/locks` | `{locks: StepLock[], checkout: RunCheckout \| null}` (active only) |
| `POST /runs/{id}/steps/{step}/lock` | `{device_id, force?}` → `StepLock`; 409 with holder in `detail` |
| `POST /locks/{id}/heartbeat`, `DELETE /locks/{id}` | optional `?device_id=` lets another user of the holding tablet act |
| `POST /runs/{id}/checkout`, `DELETE /runs/{id}/checkout` | `{device_id, hours?}` → `RunCheckout` |
| `GET /runs/{id}/verify` | `{ok, event_count, first_bad_seq?, errors[]}` |
| `GET /runs/{id}/record.json`, `record.pdf` | as-run record §10 |
| `GET/POST /tools`, `PUT /tools/{id}`, `GET /workstations`, `PUT /workstations/{code}` | registry (writes: admin) |
| `GET /ncrs?status=&run_id=`, `GET /ncrs/{id}` | NCR register (maintained from run events) |

## Behaviour notes (decisions within the contract)

- **Hashing.** `app/canonical.py` validates before `json.dumps`: floats (including `1.0`), NaN/Infinity,
  integers beyond ±(2^53−1) and lone surrogates are rejected. Push bodies are parsed without floats so the
  error names the path (`float not allowed at $.payload.value`).
- **Storage of events.** Each event's exact canonical JSON is stored (`run_events.canonical`); the indexed
  columns are copies. `/verify` recomputes canonical form, content hash, chain, sequence contiguity and
  cross-checks the columns. The `run_events` and `approvals` tables also carry an append-only trigger.
- **Ingest.** One transaction per event; the run row is locked (`SELECT … FOR UPDATE`) so `seq` is
  gap-free and the chain linear. Batches are processed in client order except that `run.created` events go
  first. Validation order: structural (schema, floats, hash, device) → duplicate check → run exists / open →
  actor & role → business rules on the projection → lock evaluation → append.
- **Duplicates** are reported even for events on a since-closed run (idempotent retries after `run.completed`).
- **Actors.** `auth_method: "oidc"` → actor must be the authenticated user (roles from token ∪ DB).
  `"pin"` → actor may be another active user who has a PIN verifier (countersign on a shared tablet); roles
  from the DB; `run_events.pushed_by` records the authenticated session that uploaded it.
- **Locks (§6).** Evaluated for step results (`step.started`, `input.recorded`, `step.completed`,
  `step.verified`). Notes, NCRs, supervisory and run-level events are not lock-bound (a supervisor adding a
  note from their own device must not put the step into conflict). Lease history is kept (`step_locks`/`run_checkouts` are never deleted), so evaluation at
  `client_ts` is exact: held → no flag; another device held it → `conflict` (+`unlocked` if this device never
  held one before); own lease expired and nobody else since → `late_lock`; never held → `unlocked`, plus
  `conflict` if another device's live value for the same input differs. Expired leases cannot be
  heartbeated back to life (the gap must stay visible). Lock takeover notes are run-level (`step_id: null`)
  so they don't change step state; the text names the step.
- **Tools.** Scan inputs with `entity: "tool"` are looked up by code (`st:tool:` / `/q/tool/` QR payloads
  accepted). Calibration is evaluated as it was effective at `client_ts` (`tool_history`), valid through
  the due date inclusive; inactive → `tool_expired`, unknown → `tool_unknown`. The result is snapshotted per
  event (`event_tool_checks`) for the record.
- **`blob_missing` is derived, not stored.** Stored flags are immutable; `blob_missing` is computed whenever an
  event is serialised (push result, pull, record) from whether its photo blobs exist. Uploading a blob writes
  change-log entries for referencing events so the next pull re-delivers them without the flag.
  `run.completed` is rejected while any live photo reference is missing.
- **Revisions.** Letters follow ASME Y14.35 (I, O, Q, S, X, Z skipped). Only one draft/in-review revision
  per procedure. Anyone who edited a draft (author or contributor) may not approve or reject it.
  Submit runs semantic checks (unique ids, dependencies exist and are acyclic, min ≤ nominal ≤ max, photo
  counts, workstation codes exist, reference images uploaded). Approval re-checks the frozen hash.
  Rejecting returns to draft and clears `content_hash` (the decision keeps the hash it applied to).
- **NCR numbers** `NCR-<year of client_ts>-NNNN`; a client-proposed `number` is used if unique.
  `ncr.closed` requires a prior disposition.
- **Pull** cursor = `change_log.id`. Inserts into `change_log` take a transaction-level advisory lock held to
  commit, so ids become visible in order and a cursor never skips a late-committing change.
  Deactivated users are shipped without roles/PIN so devices revoke offline sign-in.

## Tests

Real Postgres (database `steptrack_test`, recreated and migrated per session; override with
`TEST_DATABASE_URL`), S3 mocked with moto:

```bash
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

## Maintenance

```bash
uv run alembic revision --autogenerate -m "..."   # after changing app/models.py
uv run alembic check                              # models and migrations in sync
uv run python -m app.export_openapi               # regenerate openapi.json (a test checks it is current)
```
