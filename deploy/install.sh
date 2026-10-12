#!/usr/bin/env bash
# =============================================================================
# ZOLEX — first-time production install
#
#   ./deploy/install.sh
#
# Prepares a host to run ZOLEX: checks prerequisites, creates the data
# directories OUTSIDE the source tree, generates real secrets, and writes
# .env.deploy. It does not start anything — review the file first, then run
# `docker compose up -d --build`.
#
# Safe to re-run: it never overwrites an existing .env.deploy.
# =============================================================================
set -euo pipefail

RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; OFF=$'\e[0m'
ok()   { echo "  ${GREEN}✓${OFF} $*"; }
warn() { echo "  ${YELLOW}!${OFF} $*"; }
die()  { echo "  ${RED}✗${OFF} $*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
ENV_FILE="${HERE}/.env.deploy"

echo
echo "${BOLD}ZOLEX Purchase-to-Store ERP — production install${OFF}"
echo "───────────────────────────────────────────────────────────────"

# ── Prerequisites ────────────────────────────────────────────────────────────
echo
echo "Prerequisites"
command -v docker >/dev/null 2>&1 || die "docker is not installed — see https://docs.docker.com/engine/install/"
ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"

docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required (not the legacy docker-compose)"
ok "compose $(docker compose version --short)"

docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
ok "docker daemon is running"

command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
ok "openssl present"

# ── Data directories, outside the source tree ────────────────────────────────
echo
echo "Persistent storage"
DATA_ROOT="${ZOLEX_DATA_ROOT:-/var/lib/zolex}"
BACKUP_DIR="${DATA_ROOT}/backups"
SECRET_DIR="${DATA_ROOT}/secrets"

case "${DATA_ROOT}" in
  "${ROOT}"*) die "ZOLEX_DATA_ROOT (${DATA_ROOT}) is inside the source tree. Database and backups must live outside it." ;;
esac

mkdir -p "${BACKUP_DIR}" "${SECRET_DIR}"
chmod 750 "${DATA_ROOT}" "${BACKUP_DIR}"
chmod 700 "${SECRET_DIR}"
ok "data root  : ${DATA_ROOT}"
ok "backups    : ${BACKUP_DIR}  (mode 750)"
ok "secrets    : ${SECRET_DIR}  (mode 700)"

# ── Configuration ────────────────────────────────────────────────────────────
echo
echo "Configuration"
if [[ -f "${ENV_FILE}" ]]; then
  warn "${ENV_FILE} already exists — leaving it untouched"
  warn "Delete it first if you want fresh secrets generated."
else
  # -base64 48 gives ~64 printable characters of real entropy per secret.
  AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  AUTH_REFRESH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # Alphanumeric only: the password also travels inside a DATABASE_URL.
  PG_PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)"

  read -rp "  Public URL of this deployment [https://erp.example.com]: " FRONTEND_URL
  FRONTEND_URL="${FRONTEND_URL:-https://erp.example.com}"

  umask 077
  cat > "${ENV_FILE}" <<EOF
# ZOLEX production configuration — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# THIS FILE CONTAINS SECRETS. It is git-ignored. Never commit it, never paste it
# into a ticket, never copy it to a shared drive.

# ── Database ────────────────────────────────────────────────────────────────
POSTGRES_DB=zolex_production
POSTGRES_USER=zolex
POSTGRES_PASSWORD=${PG_PASSWORD}

# ── Application ─────────────────────────────────────────────────────────────
FRONTEND_URL=${FRONTEND_URL}
HTTP_PORT=80
HTTPS_PORT=443

# ── Secrets (generated; rotating them signs everyone out) ───────────────────
AUTH_SECRET=${AUTH_SECRET}
AUTH_REFRESH_SECRET=${AUTH_REFRESH_SECRET}

# ── Storage ─────────────────────────────────────────────────────────────────
ZOLEX_BACKUP_DIR=${BACKUP_DIR}
TLS_CERT_DIR=${DATA_ROOT}/certs

# ── Google Sheets (optional) ────────────────────────────────────────────────
# Put the service-account JSON in ${SECRET_DIR} and point GOOGLE_KEY_HOST_PATH
# at it. Leave both blank to run without Google Sheets.
GOOGLE_SHEET_ID=
GOOGLE_KEY_HOST_PATH=
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=
EOF
  chmod 600 "${ENV_FILE}"
  ok "wrote ${ENV_FILE} (mode 600)"
  ok "generated AUTH_SECRET, AUTH_REFRESH_SECRET and a PostgreSQL password"
fi

# ── Next steps ───────────────────────────────────────────────────────────────
echo
echo "───────────────────────────────────────────────────────────────"
echo "${BOLD}Next steps${OFF}"
cat <<EOF

  1. Review the configuration:
       \$EDITOR ${ENV_FILE}

  2. Build and start:
       cd ${HERE} && docker compose --env-file ./.env.deploy up -d --build

  3. Apply the schema (creates a CLEAN production database — no demo data):
       ./deploy/migrate.sh --clean

  4. Sign in at \$FRONTEND_URL as 10221 / Admin@12345.
     ${YELLOW}You will be forced to change the password immediately.${OFF}
     Do the same for 10422.

  5. Schedule backups and TEST A RESTORE:
       ./deploy/backup.sh          # add to cron, e.g. 0 2 * * *
       ./deploy/restore.sh --list

  ${YELLOW}An untested backup is not a backup.${OFF}

EOF
