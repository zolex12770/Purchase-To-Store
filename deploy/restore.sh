#!/usr/bin/env bash
# =============================================================================
# ZOLEX — restore from a backup
#
#   ./deploy/restore.sh --list                     show available backups
#   ./deploy/restore.sh --verify <file>            check a backup, restore nothing
#   ./deploy/restore.sh --dry-run <file>           show what would happen
#   ./deploy/restore.sh <file>                     restore (asks for confirmation)
#
# RESTORING REPLACES THE CURRENT DATABASE. The script therefore:
#   • verifies the backup BEFORE touching anything,
#   • takes a safety dump of the current state first,
#   • requires you to type the word RESTORE.
#
# Test this on a scratch host before you need it. An untested restore path is
# indistinguishable from having no backups at all.
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

BACKUP_DIR="${ZOLEX_BACKUP_DIR:-${HERE}/backups}"
COMPOSE=(docker compose --env-file "${ENV_FILE}")
cd "${HERE}"

MODE="restore"; TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)    MODE="list"; shift ;;
    --verify)  MODE="verify"; TARGET="${2:?--verify needs a file}"; shift 2 ;;
    --dry-run) MODE="dry-run"; TARGET="${2:?--dry-run needs a file}"; shift 2 ;;
    -*) die "Unknown option: $1" ;;
    *) TARGET="$1"; shift ;;
  esac
done

# ── List ─────────────────────────────────────────────────────────────────────
if [[ "${MODE}" == "list" ]]; then
  echo
  echo "${BOLD}Backups in ${BACKUP_DIR}${OFF}"
  echo "───────────────────────────────────────────────────────────────"
  shopt -s nullglob
  found=0
  for f in "${BACKUP_DIR}"/zolex-*.dump "${BACKUP_DIR}"/zolex-*.json; do
    printf '  %-46s %8s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" \
      "$(date -r "$f" '+%Y-%m-%d %H:%M')"
    found=$((found + 1))
  done
  [[ ${found} -eq 0 ]] && warn "no backups found — run ./deploy/backup.sh"
  echo
  exit 0
fi

[[ -n "${TARGET}" ]] || die "No backup specified. Try: ./deploy/restore.sh --list"
[[ "${TARGET}" == /* ]] || TARGET="${BACKUP_DIR}/${TARGET}"
[[ -f "${TARGET}" ]] || die "Backup not found: ${TARGET}"

echo
echo "${BOLD}ZOLEX restore${OFF}"
echo "───────────────────────────────────────────────────────────────"
echo "Backup : $(basename "${TARGET}")"
echo "Size   : $(du -h "${TARGET}" | cut -f1)"
echo "Created: $(date -r "${TARGET}" '+%Y-%m-%d %H:%M:%S')"

# ── Verify before doing anything ─────────────────────────────────────────────
echo
echo "Verification"
case "${TARGET}" in
  *.dump)
    "${COMPOSE[@]}" exec -T db pg_restore --list /dev/stdin < "${TARGET}" > /tmp/zolex-toc.txt 2>/dev/null \
      || die "This dump is unreadable and will NOT be restored."
    ok "archive is readable ($(grep -c ';' /tmp/zolex-toc.txt || echo '?') objects)"
    ;;
  *.json)
    command -v jq >/dev/null 2>&1 \
      && { jq -e '.meta.product and .data' "${TARGET}" >/dev/null || die "Not a valid ZOLEX export."; ok "structure is valid"; } \
      || warn "jq not installed — structure not checked here (the app re-verifies its checksum on restore)"
    ;;
  *) die "Unrecognised backup type. Expected .dump or .json." ;;
esac

if [[ "${MODE}" == "verify" ]]; then
  echo
  echo "${GREEN}Verification passed. Nothing was changed.${OFF}"
  exit 0
fi

if [[ "${MODE}" == "dry-run" ]]; then
  echo
  echo "Would restore $(basename "${TARGET}") over database '${POSTGRES_DB}'."
  echo "A safety dump of the current database would be taken first."
  echo "${GREEN}Dry run only — nothing was changed.${OFF}"
  exit 0
fi

# ── Confirm ──────────────────────────────────────────────────────────────────
echo
echo "${RED}${BOLD}This REPLACES the current contents of '${POSTGRES_DB}'.${OFF}"
echo "Every record created since this backup will be lost."
echo
read -rp "Type RESTORE to continue: " CONFIRM
[[ "${CONFIRM}" == "RESTORE" ]] || { echo "Aborted. Nothing was changed."; exit 1; }

# ── Safety dump of the CURRENT state ─────────────────────────────────────────
echo
echo "Safety dump of the current database"
SAFETY="${BACKUP_DIR}/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${COMPOSE[@]}" exec -T db pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    --format=custom --compress=9 --no-owner --no-privileges > "${SAFETY}"
[[ -s "${SAFETY}" ]] || die "Safety dump failed — refusing to restore."
chmod 600 "${SAFETY}"
ok "current state saved to $(basename "${SAFETY}")"

# ── Restore ──────────────────────────────────────────────────────────────────
echo
echo "Restoring"
# Stop the API so nothing writes while the schema is being replaced.
"${COMPOSE[@]}" stop api >/dev/null
ok "API stopped"

case "${TARGET}" in
  *.dump)
    "${COMPOSE[@]}" exec -T db pg_restore -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
        --clean --if-exists --no-owner --no-privileges --single-transaction /dev/stdin < "${TARGET}" \
      || { warn "restore failed — bringing the API back on the PREVIOUS data"; "${COMPOSE[@]}" start api >/dev/null; die "Restore aborted. Recovery point: $(basename "${SAFETY}")"; }
    ok "database restored"
    ;;
  *.json)
    "${COMPOSE[@]}" start api >/dev/null
    sleep 5
    "${COMPOSE[@]}" exec -T api node dist/db/cli-restore.js "/data/backups/$(basename "${TARGET}")" \
      || die "Restore failed. Recovery point: $(basename "${SAFETY}")"
    ok "application data restored"
    ;;
esac

"${COMPOSE[@]}" start api >/dev/null
ok "API restarted"

# ── Verify the result ────────────────────────────────────────────────────────
echo
echo "Post-restore verification"
sleep 8
"${COMPOSE[@]}" exec -T api node dist/db/cli-doctor.js \
  || die "The restored database FAILED its integrity checks. Recovery point: $(basename "${SAFETY}")"

echo
echo "${GREEN}Restore complete and verified.${OFF}"
echo "Previous state is still available at: $(basename "${SAFETY}")"
echo
