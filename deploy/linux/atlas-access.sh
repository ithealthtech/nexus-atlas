#!/usr/bin/env bash
# Sets how people reach Atlas, and makes the web proxy, Atlas's settings, and any tunnel agree.
#
#   atlas-access apply --mode direct     --public-url https://atlas.example.com
#   atlas-access apply --mode cloudflare --public-url https://atlas.example.com [--token-file FILE]
#   atlas-access apply --mode tailscale  [--funnel] [--auth-key-file FILE]
#   atlas-access apply --mode proxy      --public-url https://atlas.example.com --trusted 10.0.0.5,10.0.1.0/24
#   atlas-access reapply      the saved choice again (the installer runs this on every install)
#
# Modes:
#   direct      Caddy serves Atlas on 443: a public certificate for a DNS name, its own authority otherwise.
#   cloudflare  A Cloudflare Tunnel (cloudflared) carries visitors to Atlas; no inbound ports. In the Cloudflare
#               dashboard, point the tunnel's public hostname at http://localhost:4318.
#   tailscale   Tailscale Serve (your tailnet) or Funnel (the internet) serves Atlas at its .ts.net name, with
#               Tailscale's own certificate.
#   proxy       Your own reverse proxy (nginx, Traefik, IIS, Nginx Proxy Manager, ...) terminates HTTPS and
#               sends requests to this server on port 80. Only the addresses given may.
#
# Atlas has one address. Every mode sets PUBLIC_URL and TRUST_PROXY in atlas.env, and the choice is saved in
# access.conf. If Atlas doesn't answer afterwards, the previous settings are put back.
# Secrets (the tunnel token, the Tailscale auth key) are read from files, never from the command line, and are
# kept only where root can read them.
set -euo pipefail

CONF_DIR="${ATLAS_CONF_DIR:-/etc/msp-atlas}"
ENV_FILE="$CONF_DIR/atlas.env"
ACCESS_FILE="$CONF_DIR/access.conf"
CF_ENV="$CONF_DIR/cloudflared.env"
CADDYFILE="${ATLAS_CADDYFILE:-/etc/caddy/Caddyfile}"
CF_UNIT="/etc/systemd/system/msp-atlas-cloudflared.service"
LOOPBACK="127.0.0.1,::1"

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "==> $*"; }

setting() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
PORT="$(setting PORT)"; PORT="${PORT:-4318}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "PORT in $ENV_FILE isn't a number."

# ---------- checks on everything that comes in ----------
valid_url() { [[ "$1" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]]; }
valid_cidr() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]] && return 0
  [[ "$1" =~ ^[0-9A-Fa-f:]{2,39}(/([0-9]{1,2}|1[01][0-9]|12[0-8]))?$ && "$1" == *:* ]]
}
# A tunnel token is base64; an auth key is tskey-... Both are read from a root-owned file.
read_secret() { # file pattern
  [[ -f "$1" && ! -L "$1" ]] || die "Can't read $1."
  local value; value="$(head -c 4096 "$1" | tr -d '\r\n ')"
  [[ "$value" =~ $2 ]] || die "That doesn't look like the right kind of key."
  printf '%s' "$value"
}

# ---------- settings ----------
set_env() { # key value
  local tmp; tmp="$(mktemp "$CONF_DIR/.atlas.env.XXXXXX")"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" || true
  echo "$1=$2" >> "$tmp"
  chown --reference="$ENV_FILE" "$tmp"; chmod --reference="$ENV_FILE" "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}
save_choice() { # mode url trusted funnel
  local tmp; tmp="$(mktemp "$CONF_DIR/.access.XXXXXX")"
  printf 'MODE=%s\nPUBLIC_URL=%s\nTRUSTED=%s\nFUNNEL=%s\n' "$1" "$2" "$3" "$4" > "$tmp"
  chmod 0644 "$tmp"; mv -f "$tmp" "$ACCESS_FILE"
}

# ---------- the web proxy ----------
host_of() { local h="${1#https://}"; echo "${h%%/*}"; }
write_caddy() { mkdir -p "$(dirname "$CADDYFILE")"; cat > "$CADDYFILE"; }
caddy_direct() { # url
  local site; site="$(host_of "$1")"
  local bare="${site%%:*}" tls=""
  if [[ "$bare" =~ ^[0-9.]+$ || "$bare" != *.* ]]; then tls=$'\ttls internal'; fi
  write_caddy <<EOF
$site {
$tls
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
	header -Server
}
EOF
}
# A tunnel serves Atlas, so Caddy only sends anyone who comes to this server's own address to the real one.
caddy_redirect() { # url
  write_caddy <<EOF
{
	auto_https off
}
:80 {
	redir $1{uri} 308
}
EOF
}
caddy_proxy() { # trusted (comma-separated)
  local list="${1//,/ }"
  write_caddy <<EOF
{
	auto_https off
	servers {
		trusted_proxies static $list
	}
}
:80 {
	@proxy remote_ip $list
	handle @proxy {
		encode zstd gzip
		reverse_proxy 127.0.0.1:$PORT
		header -Server
	}
	respond "Use the address your reverse proxy serves Atlas at." 403
}
EOF
}
reload_caddy() {
  command -v caddy >/dev/null || return 0
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || die "The web proxy refused the new settings."
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

# ---------- tunnels ----------
stop_cloudflared() { systemctl disable --now msp-atlas-cloudflared 2>/dev/null || true; }
stop_tailscale_serve() {
  command -v tailscale >/dev/null || return 0
  tailscale serve reset >/dev/null 2>&1 || true
  tailscale funnel reset >/dev/null 2>&1 || true
}

install_cloudflared() {
  command -v cloudflared >/dev/null && return 0
  note "Installing cloudflared"
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q >/dev/null && apt-get install -y -q cloudflared >/dev/null
}
start_cloudflared() { # token-file (optional when one is saved)
  install_cloudflared
  if [[ -n "${1:-}" ]]; then
    local token; token="$(read_secret "$1" '^[A-Za-z0-9+/=_-]{40,2048}$')"
    umask 077; printf 'TUNNEL_TOKEN=%s\n' "$token" > "$CF_ENV"; chmod 0600 "$CF_ENV"; chown root:root "$CF_ENV"
  fi
  [[ -s "$CF_ENV" ]] || die "Paste the tunnel's token: there isn't one saved yet."
  cat > "$CF_UNIT" <<'EOF'
[Unit]
Description=Cloudflare Tunnel for MSP Atlas
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/msp-atlas/cloudflared.env
ExecStart=/usr/bin/env cloudflared --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5
DynamicUser=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable msp-atlas-cloudflared >/dev/null 2>&1
  systemctl restart msp-atlas-cloudflared
  for _ in $(seq 1 15); do systemctl is-active --quiet msp-atlas-cloudflared && return 0; sleep 2; done
  die "The tunnel didn't start. On the server, run: journalctl -u msp-atlas-cloudflared -n 30"
}

install_tailscale() {
  command -v tailscale >/dev/null && return 0
  note "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
}
tailscale_name() {
  tailscale status --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const n = JSON.parse(s).Self?.DNSName ?? ""; process.stdout.write(n.replace(/\.$/, "")); } catch {}
    });'
}
start_tailscale() { # funnel(yes|no) auth-key-file(optional)
  install_tailscale
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
  if [[ -z "$(tailscale_name)" ]]; then
    [[ -n "${2:-}" ]] || die "This server isn't signed in to Tailscale. Paste an auth key from the Tailscale admin console."
    read_secret "$2" '^tskey-[A-Za-z0-9_-]{10,200}$' > /dev/null
    tailscale up --auth-key="file:$2" --hostname=atlas >/dev/null 2>&1 \
      || die "Tailscale refused the auth key. Make a new one in the Tailscale admin console."
  fi
  local name; name="$(tailscale_name)"
  [[ -n "$name" ]] || die "Tailscale is signed in but has no name for this server yet. Turn on MagicDNS for the tailnet."
  stop_tailscale_serve
  local cmd=serve; [[ "$1" == yes ]] && cmd=funnel
  tailscale "$cmd" --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null 2>&1 \
    || die "Tailscale wouldn't serve Atlas. Turn on HTTPS certificates$([[ "$1" == yes ]] && echo ' and Funnel') for the tailnet in the Tailscale admin console."
  echo "https://$name"
}

# ---------- whether Atlas answers ----------
atlas_ready() { # url tries
  local host; host="$(host_of "$1")"
  for _ in $(seq 1 "$2"); do
    curl -fsS -m 5 -H "Host: $host" "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ---------- apply ----------
apply() { # mode url trusted funnel token-file auth-key-file
  local mode="$1" url="$2" trusted="$3" funnel="$4" token="${5:-}" authkey="${6:-}"
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing. Install Atlas first."
  case "$mode" in direct|cloudflare|tailscale|proxy) ;; *) die "Choose direct, cloudflare, tailscale or proxy." ;; esac
  [[ "$funnel" == yes ]] || funnel=no
  if [[ "$mode" == proxy ]]; then
    [[ -n "$trusted" ]] || die "Give the address of your reverse proxy."
    local t; for t in ${trusted//,/ }; do valid_cidr "$t" || die "$t isn't an address or range."; done
  else
    trusted=""
  fi
  [[ "$mode" == tailscale ]] || valid_url "$url" || die "The address must look like https://atlas.example.com."

  # Keep what's there, to put back if Atlas doesn't come up.
  local backup; backup="$(mktemp -d)"
  cp -p "$ENV_FILE" "$backup/atlas.env"
  [[ -f "$CADDYFILE" ]] && cp -p "$CADDYFILE" "$backup/Caddyfile"
  [[ -f "$ACCESS_FILE" ]] && cp -p "$ACCESS_FILE" "$backup/access.conf"
  local old_mode; old_mode="$( (grep -E '^MODE=' "$ACCESS_FILE" 2>/dev/null || echo MODE=direct) | cut -d= -f2)"
  restore() {
    note "Putting the previous settings back"
    cp -p "$backup/atlas.env" "$ENV_FILE"
    [[ -f "$backup/Caddyfile" ]] && cp -p "$backup/Caddyfile" "$CADDYFILE"
    if [[ -f "$backup/access.conf" ]]; then cp -p "$backup/access.conf" "$ACCESS_FILE"; else rm -f "$ACCESS_FILE"; fi
    [[ "$mode" == cloudflare && "$old_mode" != cloudflare ]] && stop_cloudflared
    [[ "$mode" == tailscale && "$old_mode" != tailscale ]] && stop_tailscale_serve
    reload_caddy || true
    systemctl restart msp-atlas || true
  }

  (
    set -e
    case "$mode" in
      direct)
        stop_cloudflared; stop_tailscale_serve
        caddy_direct "$url"
        trusted="$LOOPBACK"
        ;;
      cloudflare)
        stop_tailscale_serve
        start_cloudflared "$token"
        caddy_redirect "$url"
        trusted="$LOOPBACK"
        ;;
      tailscale)
        stop_cloudflared
        # Caddy must give up 443 before Tailscale can serve on it.
        caddy_redirect "https://placeholder.invalid"; reload_caddy
        url="$(start_tailscale "$funnel" "$authkey" | tail -1)"
        caddy_redirect "$url"
        trusted="$LOOPBACK"
        ;;
      proxy)
        stop_cloudflared; stop_tailscale_serve
        caddy_proxy "$trusted"
        trusted="$LOOPBACK,$trusted"
        ;;
    esac
    set_env PUBLIC_URL "$url"
    set_env TRUST_PROXY "$trusted"
    reload_caddy
    systemctl restart msp-atlas
    atlas_ready "$url" 45 || { echo "Atlas didn't answer at its new address." >&2; exit 1; }
    save_choice "$mode" "$url" "${trusted#"$LOOPBACK"}" "$funnel"
    echo "$url" > "$backup/url"
  ) || { restore; rm -rf "$backup"; die "Nothing was changed: the previous settings are back."; }
  url="$(cat "$backup/url")"; rm -rf "$backup"
  echo "Atlas is reached at $url"
}

# ---------- command line ----------
cmd="${1:-}"; shift || true
MODE="" URL="" TRUSTED="" FUNNEL=no TOKEN_FILE="" KEY_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:?}"; shift 2 ;;
    --public-url) URL="${2:?}"; shift 2 ;;
    --trusted) TRUSTED="${2:?}"; shift 2 ;;
    --funnel) FUNNEL=yes; shift ;;
    --token-file) TOKEN_FILE="${2:?}"; shift 2 ;;
    --auth-key-file) KEY_FILE="${2:?}"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ $EUID -eq 0 ]] || die "Run as root."
case "$cmd" in
  apply) apply "$MODE" "${URL%/}" "${TRUSTED#,}" "$FUNNEL" "$TOKEN_FILE" "$KEY_FILE" ;;
  reapply)
    [[ -f "$ACCESS_FILE" ]] || exit 0
    # Read the saved choice as data, not as a script.
    m="$(grep -E '^MODE=' "$ACCESS_FILE" | cut -d= -f2)"; u="$(grep -E '^PUBLIC_URL=' "$ACCESS_FILE" | cut -d= -f2-)"
    t="$(grep -E '^TRUSTED=' "$ACCESS_FILE" | cut -d= -f2)"; f="$(grep -E '^FUNNEL=' "$ACCESS_FILE" | cut -d= -f2)"
    apply "$m" "$u" "${t#,}" "$f" ""
    ;;
  *) die "Usage: atlas-access apply --mode direct|cloudflare|tailscale|proxy ... | atlas-access reapply" ;;
esac
