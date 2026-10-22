# StepTrack

Procedure authoring and execution for manual assembly, built for AS9100 / EN 9100
record-keeping: revision-controlled procedures with approval, an append-only
hash-chained as-run record, nonconformance (NCR) handling, and part/tool
traceability with calibration checks.

- **Vue 3 library** (`@steptrack/core`) that embeds into an existing Vue 3 webapp
- **Standalone app** (`apps/web`): installable PWA, Android tablet via Capacitor
- **Offline-first**: IndexedDB outbox; runs can be checked out to a tablet for offline work
- **Sync server** (`server/`): FastAPI + Postgres + S3/MinIO
- **Tablet features**: QR (workstation → step, traveller → run, part/tool → field), OCR of
  numeric displays, photo evidence

Design and API contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

```
packages/core/   Vue 3 library (domain, offline DB, sync, auth, device adapters, UI)
apps/web/        Standalone shell: PWA + Capacitor Android
server/          FastAPI sync/API server
spec/            Shared test vectors (TS + Python must both pass)
docs/            Architecture, operations
```

## Development

```bash
pnpm install
pnpm test            # all TS unit tests
pnpm typecheck
pnpm dev             # standalone web app
```

Server: see [`server/README.md`](server/README.md).
