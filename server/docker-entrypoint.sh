#!/bin/sh
set -e
# Schema migrations are idempotent; run them on every start so a new image brings its schema along.
alembic upgrade head
if [ "${SEED_DEMO:-false}" = "true" ]; then
    python -m app.seed
fi
exec "$@"
