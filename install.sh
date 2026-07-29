#!/usr/bin/env bash
# Installs the Qentra Linux Host + Docker agent as a systemd service on any
# plain Linux server — bare metal, an on-prem VM, or a cloud instance (AWS,
# Azure, GCP, DigitalOcean; it auto-detects which, if any). Run as root
# (creates a dedicated unprivileged system user to actually run the agent
# under):
#
#   curl -fsSL https://raw.githubusercontent.com/Qentra-on-call/Qentra-vm-agent/main/install.sh \
#     | QENTRA_TOKEN=<your infra:write token> bash
#
# Optional env vars (same defaults as the agent):
#   QENTRA_URL        default https://api.qentra.it.com
#   HOST_NAME         default: this instance's short hostname
#   REPORT_SECONDS    default 30
#   DOCKER_SOCKET     default /var/run/docker.sock
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/Qentra-on-call/Qentra-vm-agent/main"
INSTALL_DIR="/opt/qentra-vm-agent"
CONF_DIR="/etc/qentra-vm-agent"
SVC_USER="qentra-agent"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (needed to create the service user and install the systemd unit)." >&2
  exit 1
fi

if [ -z "${QENTRA_TOKEN:-}" ]; then
  echo "QENTRA_TOKEN is required — create an ApiToken with scope infra:write in Qentra (Infrastructure -> + Add host) and re-run:" >&2
  echo "  QENTRA_TOKEN=<token> bash install.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js..." >&2
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq nodejs
  elif command -v yum >/dev/null 2>&1; then yum install -y -q nodejs
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q nodejs
  else echo "No known package manager (apt/yum/dnf) — install Node.js >= 18 manually and re-run." >&2; exit 1
  fi
fi

# Dedicated system user, put in the docker group (if it exists) so it can
# read container stats over the Unix socket — it never starts, stops, or
# execs anything, just GETs /containers/... over the socket.
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$SVC_USER"
else
  echo "No 'docker' group found — host metrics will still report, container metrics will not until Docker is installed." >&2
fi

mkdir -p "$INSTALL_DIR" "$CONF_DIR"
curl -fsSL "$REPO_RAW/index.js" -o "$INSTALL_DIR/index.js"
# package.json declares "type": "module" — required on Node < 20.19, which
# doesn't auto-detect ES module syntax the way our Docker image's Node 20.20
# does; without it, plain `node index.js` throws "Cannot use import
# statement outside a module" on older Node (e.g. Amazon Linux 2023's yum
# nodejs package, which is v18).
curl -fsSL "$REPO_RAW/package.json" -o "$INSTALL_DIR/package.json"
chown -R "$SVC_USER:$SVC_USER" "$INSTALL_DIR"

cat > "$CONF_DIR/env" <<EOF
QENTRA_URL=${QENTRA_URL:-https://api.qentra.it.com}
QENTRA_TOKEN=${QENTRA_TOKEN}
HOST_NAME=${HOST_NAME:-$(hostname -s)}
REPORT_SECONDS=${REPORT_SECONDS:-30}
DOCKER_SOCKET=${DOCKER_SOCKET:-/var/run/docker.sock}
EOF
chmod 600 "$CONF_DIR/env" # root-owned/readable — systemd reads this as root before dropping to $SVC_USER

curl -fsSL "$REPO_RAW/qentra-vm-agent.service" -o /etc/systemd/system/qentra-vm-agent.service

systemctl daemon-reload
systemctl enable qentra-vm-agent
# `enable` alone does not restart an already-running service — re-running
# this script to pick up a fix would silently keep the OLD process alive.
systemctl restart qentra-vm-agent

echo
echo "Qentra Linux Host + Docker agent installed and started (fresh restart)."
echo "Check status:  systemctl status qentra-vm-agent"
echo "Check logs:    journalctl -u qentra-vm-agent -f"
