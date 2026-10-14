#!/usr/bin/env bash
# Does what an administrator asked for from Atlas that needs root: install an update (Updates), restart a service or
# repair the installation (Services), or change how Atlas is reached (Remote access, through atlas-access).
# Run as root by msp-atlas-updater.service when Atlas drops a request in the inbox.
#
# Atlas (the unprivileged `atlas` user) can write only to $UPDATER_DIR/inbox. Everything read
# from there is untrusted: an update's tag must look like [v]X.Y.Z and exist on the repository, and a
# service action must be one of the fixed list below. Results are written to $UPDATER_DIR/status.json
# (updates) and service.json (services), in a root-owned folder Atlas can only read.
set -euo pipefail

UPDATER_DIR="/var/lib/msp-atlas-updater"
INBOX="$UPDATER_DIR/inbox"
REQUEST="$INBOX/request.json"
STATUS="$UPDATER_DIR/status.json"
LOG="$UPDATER_DIR/last-update.log"
APP_DIR="/opt/msp-atlas"
ENV_FILE="/etc/msp-atlas/atlas.env"
INSTALLER="/usr/local/sbin/atlas-install"
REPO="https://github.com/ithealthtech/nexus-atlas.git"
[[ -f /etc/msp-atlas/updater.conf ]] && . /etc/msp-atlas/updater.conf

[[ -e "$REQUEST" || -L "$REQUEST" ]] || exit 0

TAG=""
REQUESTED_BY=""
REQUESTED_AT=""

status() { # state message [finished]
  local tmp
  tmp="$(mktemp "$UPDATER_DIR/.status.XXXXXX")"
  # updatedAt lets Atlas tell a run that's still going from one that died without saying so (reboot, kill -9).
  STATE="$1" MESSAGE="$2" FINISHED="${3:-}" TAG="$TAG" BY="$REQUESTED_BY" AT="$REQUESTED_AT" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({
      state: e.STATE, tag: e.TAG || null, requestedBy: e.BY || null, requestedAt: e.AT || null,
      finishedAt: e.FINISHED || null, message: e.MESSAGE || null, updatedAt: new Date().toISOString() }));' > "$tmp"
  chmod 0640 "$tmp"; chown root:atlas "$tmp"
  mv -f "$tmp" "$STATUS"
}

# Puts the previous code back if the installer swapped it in and then failed or was stopped.
rollback() {
  if [[ -d "$APP_DIR.old" ]]; then
    rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed" 2>/dev/null || true
    mv "$APP_DIR.old" "$APP_DIR"
    systemctl restart msp-atlas || true
  fi
}

# Whatever ends this run (an error, the systemd timeout, a signal), it never leaves status.json saying
# "running", which would block every later update.
PHASE=""   # set once status says running
DONE=""
on_exit() {
  local code=$?
  rm -rf "$WORK"
  if [[ -n "$PHASE" && -z "$DONE" ]]; then
    [[ "$PHASE" == install ]] && rollback
    status failed "The update to $TAG stopped before it finished (exit $code), so the previous version was kept. See $LOG." \
      "$(date -u +%FT%TZ)" || true
  fi
}
trap 'exit 143' TERM INT HUP

# Take the request out of the inbox first so a second trigger can't run it twice.
WORK="$(mktemp -d)"
trap on_exit EXIT
if [[ -L "$REQUEST" || ! -f "$REQUEST" ]] || [[ "$(stat -c %s "$REQUEST")" -gt 4096 ]]; then
  rm -f "$REQUEST"; status failed "The update request was not a valid file." "$(date -u +%FT%TZ)"; exit 1
fi
mv -f "$REQUEST" "$WORK/request.json"
# Check again now that it's somewhere Atlas can't swap it.
if [[ -L "$WORK/request.json" || ! -f "$WORK/request.json" ]]; then
  status failed "The update request was not a valid file." "$(date -u +%FT%TZ)"; exit 1
fi

read_field() { node -e '
  try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
        if (typeof v === "string") process.stdout.write(v.replace(/[^\w .:@+-]/g, "").slice(0, 120)); } catch {}' \
  "$WORK/request.json" "$1"; }
TAG="$(read_field tag)"
REQUESTED_BY="$(read_field requestedBy)"
REQUESTED_AT="$(read_field requestedAt)"

# ---------- services ----------
# A request from Administration -> Services. Only the action's name and who asked are read from it, and the name
# must be one of the cases in service_action: nothing from the request is ever run or used as a path.
SERVICE_STATUS="$UPDATER_DIR/service.json"
SERVICE_LOG="$UPDATER_DIR/last-service.log"
SERVICE_USER="atlas"
CONF_DIR="/etc/msp-atlas"
ACTION=""
SERVICE_DONE=""

service_status() { # state message [finished]
  local tmp
  tmp="$(mktemp "$UPDATER_DIR/.service.XXXXXX")"
  STATE="$1" MESSAGE="$2" FINISHED="${3:-}" ACTION="$ACTION" BY="$REQUESTED_BY" AT="$REQUESTED_AT" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({
      state: e.STATE, action: e.ACTION || null, requestedBy: e.BY || null, requestedAt: e.AT || null,
      finishedAt: e.FINISHED || null, message: e.MESSAGE || null, updatedAt: new Date().toISOString() }));' > "$tmp"
  chmod 0640 "$tmp"; chown root:"$SERVICE_USER" "$tmp"
  mv -f "$tmp" "$SERVICE_STATUS"
}
service_ok() { SERVICE_DONE=1; service_status succeeded "$1" "$(date -u +%FT%TZ)"; }
service_fail() { SERVICE_DONE=1; service_status failed "$1" "$(date -u +%FT%TZ)"; echo "$1" >&2; exit 1; }
# Whatever ends the run, service.json never keeps saying "running".
service_on_exit() {
  local code=$?
  rm -rf "$WORK"
  if [[ -z "$SERVICE_DONE" ]]; then
    service_status failed "That stopped before it finished (exit $code). See $SERVICE_LOG." "$(date -u +%FT%TZ)" || true
  fi
}

unit_exists() { systemctl cat "$1" >/dev/null 2>&1; }

# Whether Atlas answers, asked the way the installer asks: on its own port, by its public host name.
atlas_ready() { # tries, two seconds apart
  local url host port
  url="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  host="${url#*://}"; host="${host%%/*}"
  port="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  for _ in $(seq 1 "$1"); do
    curl -fsS -m 5 -H "Host: $host" "http://127.0.0.1:${port:-4318}/readyz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Puts owners and modes back the way the installer sets them.
repair_files() {
  local data
  data="$(grep -E '^ATLAS_DATA_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  data="${data:-/var/lib/msp-atlas}"

  # Root's own folders: Atlas can't write to them, so nothing in them could have been planted.
  mkdir -p "$CONF_DIR" "$UPDATER_DIR" "$INBOX"
  chown root:"$SERVICE_USER" "$CONF_DIR" "$UPDATER_DIR"; chmod 0750 "$CONF_DIR" "$UPDATER_DIR"
  chown "$SERVICE_USER":"$SERVICE_USER" "$INBOX"; chmod 0700 "$INBOX"
  local f
  for f in "$ENV_FILE" "$CONF_DIR/master.key"; do
    if [[ -f "$f" && ! -L "$f" ]]; then chown root:"$SERVICE_USER" "$f"; chmod 0640 "$f"; fi
  done
  if [[ -d "$APP_DIR" && ! -L "$APP_DIR" ]]; then
    chown -R root:"$SERVICE_USER" "$APP_DIR"; chmod -R u=rwX,g=rX,o= "$APP_DIR"
  fi

  # The data folder is Atlas's to write, so nothing inside it is trusted. Only the folder itself is set by path.
  # Inside it, files root left behind (a backup or a command run as root, say) are handed back to Atlas without
  # ever following a link, and only where the kernel stops an unprivileged user from hard-linking a file it
  # doesn't own. Otherwise Atlas could point a name at /etc/shadow and have it handed over.
  if [[ -d "$data" && ! -L "$data" ]]; then
    chown "$SERVICE_USER":"$SERVICE_USER" "$data"; chmod 0750 "$data"
    if [[ "$(cat /proc/sys/fs/protected_hardlinks 2>/dev/null || true)" == 1 ]]; then
      find "$data" -xdev -mindepth 1 ! -type l ! -user "$SERVICE_USER" \( -type d -o -type f -links 1 \) \
        -exec chown -h "$SERVICE_USER":"$SERVICE_USER" {} +
    else
      echo "Left files inside $data alone: fs.protected_hardlinks is off."
    fi
  fi
}

service_action() {
  trap service_on_exit EXIT
  : > "$SERVICE_LOG"; chmod 0640 "$SERVICE_LOG"; chown root:"$SERVICE_USER" "$SERVICE_LOG"
  local unit
  case "$ACTION" in
    restart-atlas)
      service_status running "Restarting Atlas."
      systemctl restart msp-atlas >> "$SERVICE_LOG" 2>&1 \
        || service_fail "Atlas didn't restart. On the server, run: journalctl -u msp-atlas -n 50"
      atlas_ready 45 \
        || service_fail "Atlas was restarted but isn't answering. On the server, run: journalctl -u msp-atlas -n 50"
      service_ok "Atlas was restarted and is answering."
      ;;
    restart-proxy)
      service_status running "Restarting the web proxy."
      unit_exists caddy.service || service_fail "This server has no caddy service to restart."
      systemctl restart caddy >> "$SERVICE_LOG" 2>&1 \
        || service_fail "The web proxy didn't restart. On the server, run: journalctl -u caddy -n 50"
      service_ok "The web proxy was restarted."
      ;;
    restart-database)
      service_status running "Restarting the database. Atlas restarts with it."
      unit_exists postgresql.service || service_fail "This server has no postgresql service to restart."
      systemctl restart postgresql >> "$SERVICE_LOG" 2>&1 \
        || service_fail "The database didn't restart. On the server, run: journalctl -u 'postgresql*' -n 50"
      # Atlas requires the database, so systemd stops it with the database; make sure it comes back.
      systemctl start msp-atlas >> "$SERVICE_LOG" 2>&1 || true
      atlas_ready 60 \
        || service_fail "The database was restarted, but Atlas isn't answering. On the server, run: journalctl -u msp-atlas -n 50"
      service_ok "The database was restarted, and Atlas is answering."
      ;;
    repair)
      service_status running "Repairing permissions and services, then restarting them."
      repair_files >> "$SERVICE_LOG" 2>&1 \
        || service_fail "Permissions couldn't be repaired. See $SERVICE_LOG on the server."
      systemctl daemon-reload >> "$SERVICE_LOG" 2>&1 || true
      for unit in postgresql.service caddy.service msp-atlas.service msp-atlas-updater.path; do
        if unit_exists "$unit"; then systemctl enable "$unit" >> "$SERVICE_LOG" 2>&1 || true; fi
      done
      if unit_exists postgresql.service; then systemctl start postgresql >> "$SERVICE_LOG" 2>&1 || true; fi
      if unit_exists caddy.service; then systemctl restart caddy >> "$SERVICE_LOG" 2>&1 || true; fi
      systemctl restart msp-atlas >> "$SERVICE_LOG" 2>&1 \
        || service_fail "Permissions were repaired, but Atlas didn't restart. On the server, run: journalctl -u msp-atlas -n 50"
      atlas_ready 60 \
        || service_fail "Permissions and services were repaired, but Atlas isn't answering. On the server, run: journalctl -u msp-atlas -n 50"
      service_ok "Permissions and services were repaired, and Atlas is answering."
      ;;
    *)
      service_fail "That isn't something this server can do."
      ;;
  esac
}

if [[ "$(read_field kind)" == service ]]; then
  ACTION="$(read_field action)"
  service_action
  exit 0
fi

# ---------- remote access ----------
# A request from Administration -> Remote access: how people reach Atlas (deploy/linux/atlas-access.sh does the
# work). Each field is checked against a strict pattern here and again by atlas-access; secrets go to files only
# root can read, never onto a command line.
if [[ "$(read_field kind)" == access ]]; then
  ACCESS_STATUS="$UPDATER_DIR/access.json"
  ACCESS_LOG="$UPDATER_DIR/last-access.log"
  ACCESS_DONE=""
  access_status() { # state message [finished]
    local tmp
    tmp="$(mktemp "$UPDATER_DIR/.access.XXXXXX")"
    STATE="$1" MESSAGE="$2" FINISHED="${3:-}" BY="$REQUESTED_BY" AT="$REQUESTED_AT" node -e '
      const e = process.env;
      process.stdout.write(JSON.stringify({
        state: e.STATE, requestedBy: e.BY || null, requestedAt: e.AT || null,
        finishedAt: e.FINISHED || null, message: e.MESSAGE || null, updatedAt: new Date().toISOString() }));' > "$tmp"
    chmod 0640 "$tmp"; chown root:atlas "$tmp"
    mv -f "$tmp" "$ACCESS_STATUS"
  }
  access_on_exit() {
    local code=$?
    rm -rf "$WORK"
    if [[ -z "$ACCESS_DONE" ]]; then
      access_status failed "That stopped before it finished (exit $code). See $ACCESS_LOG." "$(date -u +%FT%TZ)" || true
    fi
  }
  trap access_on_exit EXIT
  : > "$ACCESS_LOG"; chmod 0640 "$ACCESS_LOG"; chown root:atlas "$ACCESS_LOG"
  # Writes each checked field to its own file in $WORK; anything that doesn't match is left out.
  umask 077
  node -e '
    const fs = require("fs"); const dir = process.argv[1];
    let r = {}; try { r = JSON.parse(fs.readFileSync(dir + "/request.json", "utf8")); } catch {}
    const ok = (k, re) => (typeof r[k] === "string" && re.test(r[k]) ? r[k] : "");
    const out = {
      mode: ok("mode", /^(direct|cloudflare|tailscale|proxy)$/),
      url: ok("publicUrl", /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:\d{1,5})?$/),
      trusted: ok("trusted", /^[0-9A-Fa-f.:\/,]{2,400}$/),
      funnel: r.funnel === true ? "yes" : "no",
      token: ok("cloudflareToken", /^[A-Za-z0-9+\/=_-]{40,2048}$/),
      authkey: ok("tailscaleAuthKey", /^tskey-[A-Za-z0-9_-]{10,200}$/),
    };
    for (const [k, v] of Object.entries(out)) fs.writeFileSync(dir + "/" + k, v, { mode: 0o600 });' "$WORK"
  args=(apply --mode "$(cat "$WORK/mode")")
  [[ -s "$WORK/url" ]] && args+=(--public-url "$(cat "$WORK/url")")
  [[ -s "$WORK/trusted" ]] && args+=(--trusted "$(cat "$WORK/trusted")")
  [[ "$(cat "$WORK/funnel")" == yes ]] && args+=(--funnel)
  [[ -s "$WORK/token" ]] && args+=(--token-file "$WORK/token")
  [[ -s "$WORK/authkey" ]] && args+=(--auth-key-file "$WORK/authkey")
  access_status running "Changing how Atlas is reached. Atlas restarts on its new address."
  # An update is installed by the previous release's installer, which may not know about atlas-access yet. Take
  # the copy shipped with the running release (root-owned, in the read-only program folder) when it's missing or
  # differs, so the first update after the script was added can still use it.
  SHIPPED="$APP_DIR/deploy/linux/atlas-access.sh"
  if [[ -f "$SHIPPED" && ! -L "$SHIPPED" && "$(stat -c %U "$SHIPPED")" == root ]] \
    && ! cmp -s "$SHIPPED" /usr/local/sbin/atlas-access; then
    install -m 0755 -o root -g root "$SHIPPED" /usr/local/sbin/atlas-access
  fi
  if [[ ! -x /usr/local/sbin/atlas-access ]]; then
    ACCESS_DONE=1
    access_status failed "This server doesn't have atlas-access yet. Update Atlas, or run the installer again on the server." "$(date -u +%FT%TZ)"
    exit 0
  fi
  output=""
  if output="$(/usr/local/sbin/atlas-access "${args[@]}" 2>&1)"; then
    echo "$output" >> "$ACCESS_LOG"
    ACCESS_DONE=1
    access_status succeeded "$(tail -n 1 <<<"$output")" "$(date -u +%FT%TZ)"
  else
    echo "$output" >> "$ACCESS_LOG"
    ACCESS_DONE=1
    access_status failed "$(grep -E '^ERROR:' <<<"$output" | sed 's/^ERROR: //' | tr '\n' ' ' | cut -c1-600)" "$(date -u +%FT%TZ)"
  fi
  exit 0
fi

# ---------- updates ----------
fail() { DONE=1; status failed "$1" "$(date -u +%FT%TZ)"; echo "$1" >&2; exit 1; }

# Same format Atlas offers (services/updates.ts): x.y.z with an optional leading "v".
[[ "$TAG" =~ ^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || fail "The requested version isn't a release tag."
git ls-remote --exit-code --tags "$REPO" "refs/tags/$TAG" >/dev/null 2>&1 \
  || fail "Release $TAG wasn't found on $REPO."

PHASE=backup
status running "Backing up before updating to $TAG."
: > "$LOG"; chmod 0640 "$LOG"; chown root:atlas "$LOG"
if ! (cd "$APP_DIR" && runuser -u atlas -- node --env-file="$ENV_FILE" apps/server/dist/cli/backup.js) >> "$LOG" 2>&1; then
  fail "The backup before updating failed, so nothing was changed. See $LOG."
fi

PHASE=install
status running "Installing $TAG. Atlas restarts when it's ready."
if ! "$INSTALLER" --version "$TAG" --repo "$REPO" >> "$LOG" 2>&1; then
  # The installer only swaps code after a successful build; if it got that far, put the old code back.
  rollback
  fail "Updating to $TAG failed; the previous version is running. Last lines: $(tail -n 5 "$LOG" | tr '\n' ' ' | cut -c1-600)"
fi
DONE=1
status succeeded "Atlas $TAG is installed and running." "$(date -u +%FT%TZ)"
