#!/usr/bin/env bash
# Installs an Atlas update that an administrator requested from Settings -> Updates.
# Run as root by msp-atlas-updater.service when Atlas drops a request in the inbox.
#
# Atlas (the unprivileged `atlas` user) can write only to $UPDATER_DIR/inbox. Everything read
# from there is untrusted: the tag must look like vX.Y.Z and exist on the repository. Status is
# written to $UPDATER_DIR/status.json, a root-owned folder Atlas can only read.
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
  STATE="$1" MESSAGE="$2" FINISHED="${3:-}" TAG="$TAG" BY="$REQUESTED_BY" AT="$REQUESTED_AT" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({
      state: e.STATE, tag: e.TAG || null, requestedBy: e.BY || null, requestedAt: e.AT || null,
      finishedAt: e.FINISHED || null, message: e.MESSAGE || null }));' > "$tmp"
  chmod 0640 "$tmp"; chown root:atlas "$tmp"
  mv -f "$tmp" "$STATUS"
}

# Take the request out of the inbox first so a second trigger can't run it twice.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
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

fail() { status failed "$1" "$(date -u +%FT%TZ)"; echo "$1" >&2; exit 1; }

[[ "$TAG" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || fail "The requested version isn't a release tag."
git ls-remote --exit-code --tags "$REPO" "refs/tags/$TAG" >/dev/null 2>&1 \
  || fail "Release $TAG wasn't found on $REPO."

status running "Backing up before updating to $TAG."
: > "$LOG"; chmod 0640 "$LOG"; chown root:atlas "$LOG"
if ! (cd "$APP_DIR" && runuser -u atlas -- node --env-file="$ENV_FILE" apps/server/dist/cli/backup.js) >> "$LOG" 2>&1; then
  fail "The backup before updating failed, so nothing was changed. See $LOG."
fi

status running "Installing $TAG. Atlas restarts when it's ready."
if ! "$INSTALLER" --version "$TAG" --repo "$REPO" >> "$LOG" 2>&1; then
  # The installer only swaps code after a successful build; if it got that far, put the old code back.
  if [[ -d "$APP_DIR.old" ]]; then
    rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed" 2>/dev/null || true
    mv "$APP_DIR.old" "$APP_DIR"
    systemctl restart msp-atlas || true
  fi
  fail "Updating to $TAG failed; the previous version is running. Last lines: $(tail -n 5 "$LOG" | tr '\n' ' ' | cut -c1-600)"
fi
status succeeded "Atlas $TAG is installed and running." "$(date -u +%FT%TZ)"
