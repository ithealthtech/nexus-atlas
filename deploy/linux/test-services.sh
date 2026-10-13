#!/usr/bin/env bash
# Runs atlas-updater.sh's service actions against real systemd, with stand-ins for Atlas and its web proxy.
# CI runs it as root on a throwaway machine. It creates the `atlas` user, /opt/msp-atlas, /etc/msp-atlas,
# /var/lib/msp-atlas, /var/lib/msp-atlas-updater, and units named like the real ones, so it refuses to run anywhere
# Atlas is installed.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root, on a throwaway machine." >&2; exit 1; }
[[ "${CI:-}" == true ]] || { echo "This is for CI: it creates users, folders, and services. Set CI=true to run it anyway." >&2; exit 1; }
for path in /opt/msp-atlas /etc/msp-atlas /var/lib/msp-atlas /var/lib/msp-atlas-updater /etc/systemd/system/msp-atlas.service; do
  [[ ! -e "$path" ]] || { echo "$path exists: Atlas is installed here, so this test won't run." >&2; exit 1; }
done

HERE="$(cd "$(dirname "$0")" && pwd)"
UPDATER_DIR=/var/lib/msp-atlas-updater
INBOX="$UPDATER_DIR/inbox"
DATA=/var/lib/msp-atlas
CONF=/etc/msp-atlas
APP=/opt/msp-atlas
SERVICE_JSON="$UPDATER_DIR/service.json"
NODE="$(command -v node)"
# The helper runs under systemd's own PATH and needs node there, as on a server set up by the installer.
[[ -x /usr/bin/node || -x /usr/local/bin/node ]] || ln -s "$NODE" /usr/local/bin/node

echo "== Setting up a stand-in installation"
useradd --system --home "$DATA" --shell /usr/sbin/nologin atlas
install -d -m 0750 -o atlas -g atlas "$DATA" "$DATA/backups"
install -d -m 0750 -o root -g atlas "$CONF" "$UPDATER_DIR" "$APP"
install -d -m 0700 -o atlas -g atlas "$INBOX"
printf 'PUBLIC_URL=https://atlas.test\nPORT=4318\nATLAS_DATA_DIR=%s\n' "$DATA" > "$CONF/atlas.env"
echo "not-a-real-key" > "$CONF/master.key"
chown root:atlas "$CONF/atlas.env" "$CONF/master.key"; chmod 0640 "$CONF/atlas.env" "$CONF/master.key"
install -m 0755 -o root -g root "$HERE/atlas-updater.sh" /usr/local/sbin/atlas-updater

# Answers /readyz only when asked by its public host name, as Atlas does.
cat > "$APP/standin.js" <<'EOF'
require('http')
  .createServer((req, res) => {
    res.statusCode = req.url === '/readyz' && req.headers.host === 'atlas.test' ? 200 : 404;
    res.end('{"ok":true}');
  })
  .listen(4318, '127.0.0.1');
EOF
chown root:atlas "$APP/standin.js"; chmod 0640 "$APP/standin.js"

cat > /etc/systemd/system/msp-atlas.service <<EOF
[Unit]
Description=Stand-in for MSP Atlas (helper test)

[Service]
User=atlas
ExecStart=$NODE $APP/standin.js

[Install]
WantedBy=multi-user.target
EOF
if ! systemctl cat caddy.service >/dev/null 2>&1; then
  cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Stand-in for the web proxy (helper test)

[Service]
ExecStart=/bin/sleep infinity

[Install]
WantedBy=multi-user.target
EOF
fi
if ! systemctl cat postgresql.service >/dev/null 2>&1; then
  cat > /etc/systemd/system/postgresql.service <<'EOF'
[Unit]
Description=Stand-in for the database (helper test)

[Service]
ExecStart=/bin/sleep infinity

[Install]
WantedBy=multi-user.target
EOF
fi
# The same two units the installer writes.
cat > /etc/systemd/system/msp-atlas-updater.path <<EOF
[Unit]
Description=Watch for MSP Atlas update requests

[Path]
PathExists=$INBOX/request.json
Unit=msp-atlas-updater.service

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/msp-atlas-updater.service <<'EOF'
[Unit]
Description=Install a requested MSP Atlas update

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/atlas-updater
TimeoutStartSec=30min
EOF
systemctl daemon-reload
systemctl enable --now msp-atlas caddy msp-atlas-updater.path >/dev/null 2>&1
sleep 2

field() { node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];process.stdout.write(String(v??""))}catch{}' "$1" "$2"; }
pid() { systemctl show -p MainPID --value "$1"; }
owner() { stat -c '%U:%G %a' "$1"; }
fail() {
  echo "FAIL: $*"
  echo "--- service.json";      cat "$SERVICE_JSON" 2>/dev/null || true; echo
  echo "--- last-service.log";  cat "$UPDATER_DIR/last-service.log" 2>/dev/null || true
  echo "--- helper journal";    journalctl -u msp-atlas-updater -n 40 --no-pager || true
  exit 1
}
expect() { [[ "$2" == "$3" ]] || fail "$1: expected '$3', got '$2'"; echo "ok: $1"; }

# Drops a request the way Atlas does (as the atlas user, written beside the inbox file and renamed into place),
# then waits for the helper to finish and prints how it ended.
run() { # the request's JSON, the file its result lands in
  local body="$1" out="${2:-$SERVICE_JSON}" state
  rm -f "$out"
  printf '%s' "$body" | runuser -u atlas -- tee "$INBOX/.request.tmp" >/dev/null
  runuser -u atlas -- mv "$INBOX/.request.tmp" "$INBOX/request.json"
  for _ in $(seq 1 240); do
    state="$(field "$out" state)"
    if [[ "$state" == succeeded || "$state" == failed ]]; then echo "$state"; return; fi
    sleep 0.5
  done
  echo "timed out"
}
service() { run "{\"kind\":\"service\",\"action\":\"$1\",\"requestedBy\":\"Test Admin\",\"requestedAt\":\"$(date -u +%FT%TZ)\"}"; }

echo "== Restart Atlas"
before="$(pid msp-atlas)"
expect "the helper reports success" "$(service restart-atlas)" succeeded
[[ "$(pid msp-atlas)" != "$before" ]] || fail "Atlas has the same process as before, so it wasn't restarted"
echo "ok: Atlas has a new process"
expect "the result names the action" "$(field "$SERVICE_JSON" action)" restart-atlas
expect "the result names who asked" "$(field "$SERVICE_JSON" requestedBy)" "Test Admin"
expect "only Atlas can read the result" "$(owner "$SERVICE_JSON")" "root:atlas 640"
[[ ! -e "$INBOX/request.json" ]] || fail "the request was left in the inbox"
echo "ok: the request was taken out of the inbox"

echo "== Restart the web proxy"
before="$(pid caddy)"
expect "the helper reports success" "$(service restart-proxy)" succeeded
[[ "$(pid caddy)" != "$before" ]] || fail "the web proxy has the same process as before"
echo "ok: the web proxy has a new process"

echo "== Restart the database"
expect "the helper reports success" "$(service restart-database)" succeeded
expect "the database is running" "$(systemctl is-active postgresql)" active
expect "Atlas is running afterwards" "$(systemctl is-active msp-atlas)" active

echo "== Anything that isn't on the list is refused"
before="$(pid msp-atlas)"
expect "an unknown action fails" "$(service reboot)" failed
expect "and says why" "$(field "$SERVICE_JSON" message)" "That isn't something this server can do."
expect "a command hidden in the action fails" "$(service 'restart-atlas; touch /tmp/atlas-helper-was-here')" failed
expect "a path in the action fails" "$(service '../../bin/sh')" failed
[[ ! -e /tmp/atlas-helper-was-here ]] || fail "the helper ran a command from the request"
echo "ok: nothing from the request was run"
expect "Atlas wasn't touched" "$(pid msp-atlas)" "$before"

echo "== Repair"
touch "$DATA/made-by-root" "$DATA/backups/made-by-root"; mkdir "$DATA/dir-by-root"
chown root:root "$DATA/made-by-root" "$DATA/backups/made-by-root" "$DATA/dir-by-root"
ln -s /etc/hostname "$DATA/a-link"
LINKED=""
if ln /etc/hostname "$DATA/a-hard-link" 2>/dev/null; then LINKED=1; fi
chmod 0777 "$CONF"; chown atlas:atlas "$CONF/atlas.env"; chmod 0666 "$CONF/master.key"
chmod 0777 "$INBOX"; chmod 0755 "$DATA"
systemctl disable msp-atlas >/dev/null 2>&1
systemctl stop caddy
expect "the helper reports success" "$(service repair)" succeeded
expect "a file root left in the data folder is Atlas's again" "$(stat -c %U "$DATA/made-by-root")" atlas
expect "and one in a subfolder" "$(stat -c %U "$DATA/backups/made-by-root")" atlas
expect "and a folder" "$(stat -c %U "$DATA/dir-by-root")" atlas
expect "a link in the data folder was not followed" "$(stat -c %U /etc/hostname)" root
if [[ -n "$LINKED" ]]; then expect "a hard link to a system file was left alone" "$(stat -c %U "$DATA/a-hard-link")" root; fi
expect "the data folder" "$(owner "$DATA")" "atlas:atlas 750"
expect "the settings folder" "$(owner "$CONF")" "root:atlas 750"
expect "the settings file" "$(owner "$CONF/atlas.env")" "root:atlas 640"
expect "the master key" "$(owner "$CONF/master.key")" "root:atlas 640"
expect "the inbox" "$(owner "$INBOX")" "atlas:atlas 700"
expect "the web proxy is running again" "$(systemctl is-active caddy)" active
expect "Atlas is running" "$(systemctl is-active msp-atlas)" active
expect "Atlas starts at boot again" "$(systemctl is-enabled msp-atlas)" enabled
rm -f "$DATA/a-link" "$DATA/a-hard-link"

echo "== An update request still goes to the updater"
expect "a request with no kind is treated as an update" \
  "$(run '{"tag":"not-a-release","requestedBy":"Test Admin","requestedAt":"2026-01-01T00:00:00Z"}' "$UPDATER_DIR/status.json")" failed
expect "and refused by the updater's own check" "$(field "$UPDATER_DIR/status.json" message)" "The requested version isn't a release tag."

echo "== Atlas can read service states from inside its sandbox"
# The same restrictions msp-atlas.service runs under, since that is where Atlas asks from.
seen="$(systemd-run --wait --pipe --quiet -p User=atlas -p NoNewPrivileges=true -p ProtectSystem=strict \
  -p ProtectHome=true -p PrivateTmp=true -p ProtectKernelTunables=true -p ProtectControlGroups=true \
  -p RestrictSUIDSGID=true \
  systemctl show caddy.service --no-pager --property=LoadState,ActiveState,SubState,ActiveEnterTimestampMonotonic)"
grep -qx 'ActiveState=active' <<<"$seen" || fail "systemctl show from the sandbox didn't report the proxy as active: $seen"
grep -qE '^ActiveEnterTimestampMonotonic=[0-9]+$' <<<"$seen" || fail "no start time from the sandbox: $seen"
echo "ok: states and start times are readable"
missing="$(systemd-run --wait --pipe --quiet -p User=atlas -p NoNewPrivileges=true -p ProtectSystem=strict \
  systemctl show no-such-atlas-unit.service --no-pager --property=LoadState,ActiveState)"
grep -qx 'LoadState=not-found' <<<"$missing" || fail "a missing unit wasn't reported as not-found: $missing"
echo "ok: a missing service is reported as not found"

echo
echo "The helper's service actions work."
