#!/usr/bin/env bash
# =============================================================================
# ZOLEX — create a verified backup
#
#   ./deploy/backup.sh                 full backup, verify, prune old ones
#   ./deploy/backup.sh --keep 60       keep 60 days instead of the default 30
#   ./deploy/backup.sh --no-prune      keep everything
#
# Writes TWO artefacts, because they fail differently:
#
#   *.dump  — pg_dump custom format. The real disaster-recovery artefact:
#             restores the whole cluster object-for-object.
#   *.json  — the application's own portable export. Restorable through the UI
#             or `db:restore`, and readable without PostgreSQL present.
#
# Each is verified after writing — an unverified backup is not a backup.
#
# Cron example (daily 02:00, logged):
#   0 2 * * * /opt/zolex/deploy/backup.sh >> /var/log/zolex-backup.log 2>&1
# =============================================================================
set -euo pipefail

GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BOLD=$'\e[1m'; OFF=$'\e[0m'
ok()   { echo "  ${GREEN}✓${OFF} $*"; }
warn() { echo "  ${YELLOW}!${OFF} $*"; }
die()  { echo "  ${RED}✗${OFF} $*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${HERE}/.env.deploy"
[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} not found — run ./deploy/install.sh first"

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

KEEP_DAYS=30
PRUNE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP_DAYS="${2:?--keep needs a number of days}"; shift 2 ;;
    --no-prune) PRUNE=0; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

BACKUP_DIR="${ZOLEX_BACKUP_DIR:-${HERE}/backups}"
mkdir -p "${BACKUP_DIR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/zolex-${STAMP}.dump"

COMPOSE=(docker compose --env-file "${ENV_FILE}")
cd "${HERE}"

echo
echo "${BOLD}ZOLEX backup — ${STAMP}${OFF}"
echo "───────────────────────────────────────────────────────────────"

# ── 1. pg_dump ───────────────────────────────────────────────────────────────
echo
echo "PostgreSQL dump"
"${COMPOSE[@]}" exec -T db pg_dump \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    --format=custom --compress=9 --no-owner --no-privileges \
  > "${DUMP}"

[[ -s "${DUMP}" ]] || die "pg_dump produced an empty file"
chmod 600 "${DUMP}"
ok "wrote $(basename "${DUMP}") ($(du -h "${DUMP}" | cut -f1))"

# Verify by LISTING the archive: this parses the whole file and fails on a
# truncated or corrupt dump. It reads only — it restores nothing.
if "${COMPOSE[@]}" exec -T db pg_restore --list /dev/stdin < "${DUMP}" > /dev/null 2>&1; then
  ok "dump verified (archive table of contents is readable)"
else
  die "dump FAILED verification — it is not usable. Investigate before relying on it."
fi

# ── 2. Application export ────────────────────────────────────────────────────
echo
echo "Application export"
if "${COMPOSE[@]}" exec -T api node dist/db/cli-backup.js 2>/dev/null; then
  ok "checksum-verified JSON export written to the backup volume"
else
  warn "application export unavailable — the pg_dump above is still complete"
fi

# ── 3. Prune ─────────────────────────────────────────────────────────────────
if [[ "${PRUNE}" -eq 1 ]]; then
  echo
  echo "Retention (${KEEP_DAYS} days)"
  # Never prune the newest file, whatever the retention window says: a
  # long-broken backup job must not end with zero backups on disk.
  NEWEST="$(ls -1t "${BACKUP_DIR}"/zolex-*.dump 2>/dev/null | head -1 || true)"
  REMOVED=0
  while IFS= read -r old; do
    [[ -z "${old}" || "${old}" == "${NEWEST}" ]] && continue
    rm -f "${old}"; REMOVED=$((REMOVED + 1))
  done < <(find "${BACKUP_DIR}" -maxdepth 1 -name 'zolex-*.dump' -mtime "+${KEEP_DAYS}" 2>/dev/null || true)
  ok "removed ${REMOVED} backup(s) older than ${KEEP_DAYS} days"
fi

TOTAL="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'zolex-*.dump' | wc -l)"
echo
echo "───────────────────────────────────────────────────────────────"
echo "${GREEN}Backup complete.${OFF} ${TOTAL} dump(s) in ${BACKUP_DIR}"
echo
echo "${YELLOW}Reminder: a backup you have never restored is a guess.${OFF}"
echo "Test one on a scratch host with:  ./deploy/restore.sh --list"
echo
