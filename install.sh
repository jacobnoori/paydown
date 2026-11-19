#!/usr/bin/env bash
# Debt Tracker installer for Debian / Ubuntu (e.g. a Proxmox LXC). Run as root.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/jacobnoori/debt-tracker/main/install.sh)"
#
# Safe to re-run: it updates the code and service but never touches existing data or the password.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jacobnoori/debt-tracker.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/debt-tracker
DATA_DIR=/var/lib/debt-tracker
ENV_FILE=/etc/debt-tracker.env
SVC_USER=debt-tracker
UNIT=/etc/systemd/system/debt-tracker.service

msg() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
command -v apt-get >/dev/null || die "this installer supports Debian/Ubuntu only"

msg "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 git ca-certificates curl >/dev/null

msg "Creating service user"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 750 "$DATA_DIR"

msg "Fetching code into $APP_DIR"
if [[ -d $APP_DIR/.git ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

if [[ ! -f $ENV_FILE ]]; then
  msg "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Debt Tracker settings — restart after editing: systemctl restart debt-tracker
DT_HOST=0.0.0.0
DT_PORT=8787
DT_DATA_DIR=$DATA_DIR
EOF
fi

msg "Installing systemd service"
cat > "$UNIT" <<EOF
[Unit]
Description=Debt Tracker
After=network.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/python3 $APP_DIR/server.py serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
install -m 755 "$APP_DIR/debt-tracker" /usr/local/bin/debt-tracker

if [[ ! -f $DATA_DIR/auth.json ]]; then
  msg "Set the login password"
  if [[ -r /dev/tty ]] && (exec < /dev/tty) 2>/dev/null; then
    until runuser -u "$SVC_USER" -- python3 "$APP_DIR/server.py" passwd --data-dir "$DATA_DIR" < /dev/tty; do
      echo "Try again."
    done
  else
    PW=$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')
    printf '%s\n' "$PW" | runuser -u "$SVC_USER" -- python3 "$APP_DIR/server.py" passwd --stdin --data-dir "$DATA_DIR" >/dev/null
    echo "No terminal available — generated password: $PW"
    echo "Change it later with: debt-tracker passwd"
  fi
fi

systemctl daemon-reload
systemctl enable -q debt-tracker
systemctl restart debt-tracker

# shellcheck disable=SC1090
. "$ENV_FILE"
sleep 1
if curl -fsS "http://127.0.0.1:${DT_PORT}/healthz" >/dev/null 2>&1; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  msg "Debt Tracker is running: http://${IP:-<this-host>}:${DT_PORT}/"
else
  die "service did not start — check: journalctl -u debt-tracker -n 50"
fi
echo "Manage it with: debt-tracker {status|logs|restart|update|passwd|backup}"
