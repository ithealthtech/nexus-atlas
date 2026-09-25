#!/usr/bin/env bash
# MSP Atlas installer and upgrader for Ubuntu 22.04/24.04 and Debian 12, without Docker.
# Installs Node.js 22 (NodeSource), PostgreSQL 16 (PGDG), and Caddy (HTTPS), then builds Atlas from a
# release and runs it as a systemd service with nightly backups and the web updater.
#
# One script for every release: by default it installs the newest published release.
#
#   curl -fsSL https://raw.githubusercontent.com/ithealthtech/nexus-atlas/main/deploy/linux/install-atlas.sh -o install-atlas.sh
#   sudo bash install-atlas.sh --public-url https://atlas.yourmsp.com
#
# Safe to re-run: existing settings, master key, database password, and data are kept.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo bash install-atlas.sh [options]

  --public-url URL   Address people use (https:// only). A DNS name gets a real certificate;
                     an IP address gets a self-signed one. Default: kept from the last install,
                     otherwise https://<this server's IP>.
  --version VERSION  latest (default): the newest published release.
                     Or a release tag such as v1.0.2, or a branch such as main (testing only).
  --repo URL         Git repository to install from (default: the official Atlas repository).
  -h, --help         Show this help.

Examples:
  sudo bash install-atlas.sh --public-url https://atlas.yourmsp.com   # first install, newest release
  sudo bash install-atlas.sh                                          # upgrade to the newest release
  sudo bash install-atlas.sh --version v1.0.2                         # a specific release
EOF
}

ATLAS_VERSION="latest"
REPO="https://github.com/ithealthtech/nexus-atlas.git"
PUBLIC_URL=""
APP_DIR="/opt/msp-atlas"
DATA_DIR="/var/lib/msp-atlas"
CONF_DIR="/etc/msp-atlas"
UPDATER_DIR="/var/lib/msp-atlas-updater"
SERVICE_USER="atlas"
DB_NAME="atlas"
DB_USER="atlas"
PORT="4318"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) ATLAS_VERSION="${2:?--version needs a value}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?--public-url needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo $0 ...)."
. /etc/os-release
case "$ID:${VERSION_ID:-}" in
  ubuntu:22.04 | ubuntu:24.04 | debian:12) ;;
  *) die "Supported systems: Ubuntu 22.04 or 24.04, Debian 12 (found ${PRETTY_NAME:-$ID})." ;;
esac

ENV_FILE="$CONF_DIR/atlas.env"
KEY_FILE="$CONF_DIR/master.key"

# Keep the existing public URL on upgrades unless a new one is given.
if [[ -z "$PUBLIC_URL" && -f "$ENV_FILE" ]]; then
  PUBLIC_URL="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
if [[ -z "$PUBLIC_URL" ]]; then
  PUBLIC_URL="https://$(hostname -I | awk '{print $1}')"
fi
[[ "$PUBLIC_URL" == https://* ]] || die "--public-url must start with https:// (Atlas refuses http in production)."
SITE_HOST="${PUBLIC_URL#https://}"; SITE_HOST="${SITE_HOST%%/*}"
HOST_ONLY="${SITE_HOST%%:*}"

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
# Servers installed from an ISO often keep the install media as an apt source, which breaks apt-get update.
if grep -qsE '^deb .*(cdrom:|file:///cdrom)' /etc/apt/sources.list; then
  sed -i -E 's|^(deb .*(cdrom:\|file:///cdrom).*)$|# \1|' /etc/apt/sources.list
  echo "Disabled the install-media (cdrom) apt source."
fi
apt-get update -q
apt-get install -yq ca-certificates curl gnupg git openssl debian-keyring debian-archive-keyring apt-transport-https

log "Choosing the Atlas version"
# Releases are tags like v1.2.3 (a leading v is optional). "latest" is the highest one; pre-release tags
# (v1.3.0-rc1) are never picked automatically. Anything else must exist as a tag or branch.
REMOTE_TAGS="$(git ls-remote --tags --refs "$REPO" | sed 's#.*refs/tags/##')" || die "Can't reach $REPO."
if [[ "$ATLAS_VERSION" == latest ]]; then
  ATLAS_VERSION="$(grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' <<<"$REMOTE_TAGS" | sort -V | tail -n 1 || true)"
  [[ -n "$ATLAS_VERSION" ]] || die "No published release was found on $REPO."
elif ! grep -qxF "$ATLAS_VERSION" <<<"$REMOTE_TAGS"; then
  git ls-remote --exit-code --heads "$REPO" "$ATLAS_VERSION" >/dev/null \
    || die "\"$ATLAS_VERSION\" isn't a release or branch on $REPO. Releases: $(grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' <<<"$REMOTE_TAGS" | sort -V | tail -n 5 | tr '\n' ' ')"
  echo "Note: $ATLAS_VERSION is a branch, not a release. Use it for testing only."
fi
INSTALLED="$(cat "$CONF_DIR/installed-version" 2>/dev/null || true)"
echo "Installing $ATLAS_VERSION${INSTALLED:+ (currently $INSTALLED)}."

log "PostgreSQL 16 (PGDG repository)"
if ! dpkg -s postgresql-16 >/dev/null 2>&1; then
  apt-get install -yq postgresql-common
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get install -yq postgresql-16
fi
systemctl enable --now postgresql

log "Node.js 22 (NodeSource repository)"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -yq nodejs
fi
node -v

log "Caddy (official repository)"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

log "Service account and folders"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
# The updater's folder is root's; Atlas can only read it, and write update requests to inbox/.
install -d -m 0750 -o root -g "$SERVICE_USER" "$UPDATER_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$UPDATER_DIR/inbox"

log "Master key"
if [[ ! -f "$KEY_FILE" ]]; then
  openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n' > "$KEY_FILE"
  NEW_KEY=1
fi
chown root:"$SERVICE_USER" "$KEY_FILE"; chmod 0640 "$KEY_FILE"

log "Database"
if [[ -f "$ENV_FILE" ]] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
else
  DB_PASS="$(openssl rand -hex 24)"
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    sudo -u postgres psql -q -c "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS'"
  else
    sudo -u postgres psql -q -c "CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS'"
  fi
  DATABASE_URL="postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

log "Settings ($ENV_FILE)"
declare -A SETTINGS=()
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r k v; do [[ "$k" =~ ^[A-Z_]+$ ]] && SETTINGS["$k"]="$v"; done < "$ENV_FILE"
fi
SETTINGS[NODE_ENV]=production
SETTINGS[DATABASE_URL]="$DATABASE_URL"
SETTINGS[PUBLIC_URL]="$PUBLIC_URL"
SETTINGS[HOST]=127.0.0.1
SETTINGS[PORT]="$PORT"
SETTINGS[TRUST_PROXY]=true
SETTINGS[ATLAS_MASTER_KEY_FILE]="$KEY_FILE"
SETTINGS[ATLAS_DATA_DIR]="$DATA_DIR"
SETTINGS[ATLAS_UPDATER_DIR]="$UPDATER_DIR"
if [[ "$REPO" =~ ^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$ ]]; then
  SETTINGS[ATLAS_UPDATE_REPO]="${BASH_REMATCH[1]%.git}"
fi
: "${SETTINGS[LOG_LEVEL]:=info}"
umask 027
{ for k in $(printf '%s\n' "${!SETTINGS[@]}" | sort); do echo "$k=${SETTINGS[$k]}"; done; } > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chown root:"$SERVICE_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"

log "Building Atlas $ATLAS_VERSION"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
git clone -q --depth 1 --branch "$ATLAS_VERSION" "$REPO" "$BUILD_DIR/src"
( cd "$BUILD_DIR/src" && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund )
STARTED_AT="$(date '+%F %T')"
systemctl stop msp-atlas 2>/dev/null || true
rm -rf "$APP_DIR.new" && mv "$BUILD_DIR/src" "$APP_DIR.new"
rm -rf "$APP_DIR.old"; [[ -d "$APP_DIR" ]] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
# Code is root-owned and read-only to the service account.
chown -R root:"$SERVICE_USER" "$APP_DIR"; chmod -R u=rwX,g=rX,o= "$APP_DIR"

log "systemd service (msp-atlas)"
cat > /etc/systemd/system/msp-atlas.service <<EOF
[Unit]
Description=MSP Atlas
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR $UPDATER_DIR/inbox
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

log "Updater (Settings -> Updates)"
# The units come from this (running, known-good) installer. The scripts they run are only replaced
# with the new release's copies once it has passed the readiness check below.
cat > /etc/systemd/system/msp-atlas-updater.path <<EOF
[Unit]
Description=Watch for MSP Atlas update requests

[Path]
PathExists=$UPDATER_DIR/inbox/request.json
Unit=msp-atlas-updater.service

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/msp-atlas-updater.service <<EOF
[Unit]
Description=Install a requested MSP Atlas update

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/atlas-updater
TimeoutStartSec=30min
EOF

systemctl daemon-reload
systemctl enable --now msp-atlas
systemctl enable --now msp-atlas-updater.path

log "Caddy HTTPS proxy for $SITE_HOST"
TLS_LINE=""
if [[ "$HOST_ONLY" =~ ^[0-9.]+$ || "$HOST_ONLY" != *.* ]]; then TLS_LINE="	tls internal"; fi
cat > /etc/caddy/Caddyfile <<EOF
$SITE_HOST {
$TLS_LINE
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
	header -Server
}
EOF
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

log "Waiting for Atlas"
for _ in $(seq 1 60); do
  # Atlas only answers requests addressed to its public host.
  curl -fsS -H "Host: $SITE_HOST" "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && READY=1 && break
  sleep 2
done
[[ "${READY:-}" == 1 ]] || { journalctl -u msp-atlas -n 40 --no-pager; die "Atlas did not become ready."; }
rm -rf "$APP_DIR.old"

# Only now that the new release is up: install its installer and updater (an update that fails before this
# point leaves the previous, working copies in place for the rollback and for later updates).
# Prefer the copies shipped with the release; fall back to the ones beside this script. (Releases before
# this one don't ship deploy/linux, and the updater runs this script as /usr/local/sbin/atlas-install.)
SELF="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SELF")"
INSTALL_SRC="$SELF"
UPDATER_SRC="$SCRIPT_DIR/atlas-updater.sh"; [[ -f "$UPDATER_SRC" ]] || UPDATER_SRC="$SCRIPT_DIR/atlas-updater"
if [[ -f "$APP_DIR/deploy/linux/atlas-updater.sh" ]]; then
  INSTALL_SRC="$APP_DIR/deploy/linux/install-atlas.sh"
  UPDATER_SRC="$APP_DIR/deploy/linux/atlas-updater.sh"
fi
# `install` replaces the file rather than rewriting it, so a running copy of this script isn't disturbed.
for pair in "$INSTALL_SRC:/usr/local/sbin/atlas-install" "$UPDATER_SRC:/usr/local/sbin/atlas-updater"; do
  src="${pair%%:*}"; dst="${pair#*:}"
  [[ "$(readlink -f "$src")" == "$(readlink -f "$dst")" ]] || install -m 0755 -o root -g root "$src" "$dst"
done
printf 'REPO=%q\n' "$REPO" > "$CONF_DIR/updater.conf"; chmod 0644 "$CONF_DIR/updater.conf"

echo
echo "$ATLAS_VERSION" > "$CONF_DIR/installed-version"; chmod 0644 "$CONF_DIR/installed-version"
echo "MSP Atlas $ATLAS_VERSION is running at $PUBLIC_URL"
SETUP_LINE="$(journalctl -u msp-atlas --no-pager --since "$STARTED_AT" | grep -o 'First-run setup code: .*' | tail -1 || true)"
[[ -n "$SETUP_LINE" ]] && echo "$SETUP_LINE  (valid until the first account is created)"
if [[ -n "${NEW_KEY:-}" ]]; then
  echo
  echo "A new master key was created at $KEY_FILE."
  echo "Copy it somewhere safe and separate from backups. Without it, encrypted data cannot be recovered."
fi
[[ -n "$TLS_LINE" ]] && echo "Caddy is using a self-signed certificate; browsers will warn until you trust Caddy's local CA."
echo "Logs: journalctl -u msp-atlas -f     Settings: $ENV_FILE"
