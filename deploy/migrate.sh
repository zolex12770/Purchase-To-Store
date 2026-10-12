#!/usr/bin/env bash
# =============================================================================
# ZOLEX — apply database migrations
#
#   ./deploy/migrate.sh            apply pending migrations (safe, idempotent)
#   ./deploy/migrate.sh --clean    apply, then mark the database as a CLEAN
#                                  production database (no demo data, ever)
#   ./deploy/migrate.sh --check    report pending migrations, change nothing
#
# Migrations run one-per-transaction and are recorded with a checksum, so this
# is safe to run on every deploy. A migration whose file has changed since it
# was applied is refused rather than silently re-run.
# =============================================================================
set -euo pipefail

GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; OFF=$'\e[0m'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${HERE}/.env.deploy"
COMPOSE=(docker compose --env-file "${ENV_FILE}")

[[ -f "${ENV_FILE}" ]] || { echo "${RED}✗${OFF} ${ENV_FILE} not found — run ./deploy/install.sh first" >&2; exit 1; }

MODE="apply"
for a in "$@"; do
  case "$a" in
    --clean) MODE="clean" ;;
    --check) MODE="check" ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

cd "${HERE}"

echo
echo "${BOLD}ZOLEX — database migration (${MODE})${OFF}"
echo "───────────────────────────────────────────────────────────────"

# The database must be accepting connections before anything is attempted.
echo "Waiting for PostgreSQL…"
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T db pg_isready -q; then
    echo "  ${GREEN}✓${OFF} database is ready"
    break
  fi
  [[ $i -eq 30 ]] && { echo "  ${RED}✗${OFF} database did not become ready in 60s" >&2; exit 1; }
  sleep 2
done

if [[ "${MODE}" == "check" ]]; then
  "${COMPOSE[@]}" exec -T api node dist/db/cli-migrate.js --check
  exit $?
fi

echo
echo "Applying migrations…"
"${COMPOSE[@]}" exec -T api node dist/db/cli-migrate.js

if [[ "${MODE}" == "clean" ]]; then
  echo
  echo "Marking as a clean production database…"
  # Idempotent, and it does NOT delete anything: it only records that demo
  # seeding must never run here. Purging existing data is db:purify's job.
  "${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-zolex}" -d "${POSTGRES_DB:-zolex_production}" -v ON_ERROR_STOP=1 -c \
    "INSERT INTO app_settings (key, value, description)
     VALUES ('data.purified_at', to_jsonb(now()::text),
             'Clean production database. While present, demo seeding is refused.')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
  echo "  ${GREEN}✓${OFF} demo seeding is disabled on this database"
fi

echo
echo "Verifying…"
"${COMPOSE[@]}" exec -T api node dist/db/cli-doctor.js || {
  echo "  ${YELLOW}!${OFF} the doctor reported problems — review the output above" >&2
  exit 1
}

echo
echo "${GREEN}Migration complete.${OFF}"
