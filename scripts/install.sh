#!/usr/bin/env bash
# ClawCode installer for Ubuntu 25 (and compatible Debian-based systems)
# Usage: curl -fsSL <repo>/scripts/install.sh | bash
#   or:  bash scripts/install.sh
#
# Installs: Node.js 22 LTS, Claude Code CLI, ClawCode, systemd service
# Requires: sudo access, internet connection

set -euo pipefail

# --- Configuration ---
CLAWCODE_DIR="${CLAWCODE_DIR:-/opt/clawcode}"
CLAWCODE_USER="${CLAWCODE_USER:-clawcode}"
CLAWCODE_CONFIG="${CLAWCODE_CONFIG:-/etc/clawcode/clawcode.yaml}"
NODE_MAJOR=22
LOG_FILE="/tmp/clawcode-install-$(date +%Y%m%d-%H%M%S).log"

# --- Helpers ---
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[OK]\033[0m    %s\n' "$1"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
fail()  { printf '\033[1;31m[FAIL]\033[0m  %s\n' "$1" >&2; exit 1; }

log_cmd() {
  "$@" >> "$LOG_FILE" 2>&1 || { warn "Command failed: $*  (see $LOG_FILE)"; return 1; }
}

check_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (try: sudo bash scripts/install.sh)"
  fi
}

# --- Pre-flight checks ---
preflight() {
  info "Running pre-flight checks..."

  # Check Ubuntu/Debian
  if ! command -v apt-get &>/dev/null; then
    fail "apt-get not found — this installer requires Ubuntu/Debian"
  fi

  # Check architecture
  ARCH=$(dpkg --print-architecture)
  if [[ "$ARCH" != "amd64" && "$ARCH" != "arm64" ]]; then
    fail "Unsupported architecture: $ARCH (need amd64 or arm64)"
  fi

  # Check internet
  if ! curl -fsSL --max-time 5 https://deb.nodesource.com/ &>/dev/null; then
    fail "Cannot reach package repositories — check internet connection"
  fi

  ok "Pre-flight passed (arch=$ARCH)"
}

# --- Install system dependencies ---
install_system_deps() {
  info "Installing system dependencies..."

  export DEBIAN_FRONTEND=noninteractive
  log_cmd apt-get update
  log_cmd apt-get install -y \
    curl \
    git \
    build-essential \
    python3 \
    ca-certificates \
    gnupg

  ok "System dependencies installed"
}

# --- Install Node.js 22 LTS ---
install_node() {
  if command -v node &>/dev/null; then
    CURRENT_NODE=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$CURRENT_NODE" -ge "$NODE_MAJOR" ]]; then
      ok "Node.js $(node --version) already installed"
      return 0
    fi
    warn "Node.js $(node --version) found but need v${NODE_MAJOR}+, upgrading..."
  fi

  info "Installing Node.js ${NODE_MAJOR} LTS..."

  # NodeSource setup
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list

  log_cmd apt-get update
  log_cmd apt-get install -y nodejs

  ok "Node.js $(node --version) installed"
}

# --- Install Claude Code CLI ---
install_claude_cli() {
  if command -v claude &>/dev/null; then
    ok "Claude Code CLI already installed"
    return 0
  fi

  info "Installing Claude Code CLI..."
  log_cmd npm install -g @anthropic-ai/claude-code
  ok "Claude Code CLI installed"
}

# --- Create clawcode system user ---
create_user() {
  if id "$CLAWCODE_USER" &>/dev/null; then
    ok "User '$CLAWCODE_USER' already exists"
    return 0
  fi

  info "Creating system user '$CLAWCODE_USER'..."
  useradd --system --create-home --shell /bin/bash "$CLAWCODE_USER"
  ok "User '$CLAWCODE_USER' created"
}

# --- Clone/update ClawCode ---
install_clawcode() {
  info "Installing ClawCode to ${CLAWCODE_DIR}..."

  if [[ -d "$CLAWCODE_DIR" ]]; then
    warn "$CLAWCODE_DIR exists — pulling latest..."
    cd "$CLAWCODE_DIR"
    log_cmd git pull --ff-only
  else
    # If running from a git repo, copy it; otherwise expect CLAWCODE_REPO env
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(dirname "$SCRIPT_DIR")"

    if [[ -d "$REPO_ROOT/.git" ]]; then
      info "Copying from local repo at ${REPO_ROOT}..."
      cp -a "$REPO_ROOT" "$CLAWCODE_DIR"
    elif [[ -n "${CLAWCODE_REPO:-}" ]]; then
      log_cmd git clone "$CLAWCODE_REPO" "$CLAWCODE_DIR"
    else
      fail "No git repo found and CLAWCODE_REPO not set. Either run from the repo or set CLAWCODE_REPO=<url>"
    fi
  fi

  cd "$CLAWCODE_DIR"

  info "Installing npm dependencies..."
  log_cmd npm ci --omit=dev

  info "Building..."
  log_cmd npm run build

  chown -R "$CLAWCODE_USER:$CLAWCODE_USER" "$CLAWCODE_DIR"
  ok "ClawCode installed at ${CLAWCODE_DIR}"
}

# --- Create config directory ---
setup_config() {
  info "Setting up configuration..."

  CONFIG_DIR=$(dirname "$CLAWCODE_CONFIG")
  mkdir -p "$CONFIG_DIR"

  if [[ ! -f "$CLAWCODE_CONFIG" ]]; then
    cat > "$CLAWCODE_CONFIG" <<'YAML'
# ClawCode configuration
# See docs for full reference: https://github.com/example-user/clawcode
#
# Authentication: Claude Code handles auth — no Anthropic API key needed here.
# Run `claude login` as the clawcode user before starting the service.
#
# Required: Set your Discord bot token (or use 1Password reference)
#   discord:
#     botToken: "op://example-vault/item/field"  # 1Password
#     botToken: "your-token-here"        # plaintext (not recommended)

discord:
  botToken: ""

agents: []
  # Example agent:
  # - name: assistant
  #   model: sonnet
  #   channels: ["YOUR_CHANNEL_ID"]
  #   workspace: /home/clawcode/workspaces/assistant
  #   soul: |
  #     You are a helpful assistant.
YAML
    ok "Config template created at ${CLAWCODE_CONFIG}"
    warn "Edit ${CLAWCODE_CONFIG} to configure agents before starting"
  else
    ok "Config already exists at ${CLAWCODE_CONFIG}"
  fi

  chown -R "$CLAWCODE_USER:$CLAWCODE_USER" "$CONFIG_DIR"
}

# --- Create systemd service ---
install_service() {
  info "Installing systemd service..."

  cat > /etc/systemd/system/clawcode.service <<EOF
[Unit]
Description=ClawCode Multi-Agent Orchestration Daemon
After=network-online.target
Wants=network-online.target

# INC-2026-06-04 — crash-loop burst protection. These MUST live in [Unit];
# in [Service] systemd silently ignores them (live \`systemctl show\` reported
# the 10s default and the 2026-06-04 outage looped unbounded for ~35 min,
# blowing the 1Password daily quota). The window is sized to >=5x the observed
# ~41s crash cycle (run-then-crash) so even a SLOW loop trips it: more than
# StartLimitBurst restarts within StartLimitIntervalSec -> systemd gives up and
# the unit enters 'failed' (contained hard-down) instead of hammering shared
# external quotas.
StartLimitIntervalSec=600
StartLimitBurst=5

# On hard-down (incl. StartLimit tripped) fire the alert notifier so a stopped
# fleet pages the operator instead of failing silently.
OnFailure=clawcode-failure-notify.service

[Service]
Type=simple
User=${CLAWCODE_USER}
Group=${CLAWCODE_USER}
WorkingDirectory=${CLAWCODE_DIR}

# Core command
ExecStart=/usr/bin/node ${CLAWCODE_DIR}/dist/cli/index.js start-all --foreground --config ${CLAWCODE_CONFIG}

# Environment
Environment=NODE_ENV=production
Environment=HOME=/home/${CLAWCODE_USER}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-/etc/clawcode/env

# Restart policy. NOTE: StartLimitIntervalSec / StartLimitBurst live in the
# [Unit] section above — systemd IGNORES them here (INC-2026-06-04). RestartSec
# spaces restarts; the [Unit] StartLimit window caps how many before systemd
# gives up and the unit goes 'failed'.
Restart=on-failure
# Phase 999.23 — treat exit 129 (SIGHUP-clean-shutdown) as a restart trigger.
# Daemon's SIGHUP handler exits 129 (128 + SIGHUP=1) so systemd restarts the
# daemon instead of leaving it dead. Closes the 2026-05-01 outage where an
# agent ran kill -HUP and the daemon died silently with no restart.
RestartForceExitStatus=129
RestartSec=10

# INC-2026-06-04 — bound graceful shutdown. A serial 14-agent teardown waiting
# on a wedged \`claude\` child blew past the stop timeout -> SIGKILL of the whole
# cgroup -> orphans (the incident TRIGGER). 60s is generous for the (now
# parallelized) choreographed shutdown; on overrun, KillMode=control-group
# (systemd default) still reaps the cgroup cleanly.
TimeoutStopSec=60

# Resource limits
LimitNOFILE=65536
MemoryMax=4G

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/home/${CLAWCODE_USER} ${CLAWCODE_DIR} /etc/clawcode /tmp
ProtectHome=tmpfs
BindPaths=/home/${CLAWCODE_USER}
PrivateTmp=yes

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=clawcode

[Install]
WantedBy=multi-user.target
EOF

  # INC-2026-06-04 — hard-down alert. Fired via OnFailure= from the main unit
  # when the daemon enters 'failed' (incl. StartLimit tripped). Self-contained:
  # writes a CRIT-priority journald line so the operator's existing log
  # monitoring pages even when the daemon itself is down. Extend ExecStart to
  # POST to a Discord/Slack webhook if desired.
  cat > /etc/systemd/system/clawcode-failure-notify.service <<'NOTIFY'
[Unit]
Description=ClawCode fleet hard-down alert (INC-2026-06-04)

[Service]
Type=oneshot
ExecStart=/usr/bin/logger -t clawcode-alert -p daemon.crit "ClawCode daemon entered FAILED state (crash-loop StartLimit tripped or fatal exit) — fleet is DOWN, manual intervention required"
NOTIFY

  # Create env file for optional overrides
  if [[ ! -f /etc/clawcode/env ]]; then
    cat > /etc/clawcode/env <<'ENV'
# ClawCode environment variables (optional overrides)
# Auth is handled by Claude Code — run `claude login` as the clawcode user.
# CLAWCODE_LOG_LEVEL=info
ENV
    chmod 600 /etc/clawcode/env
    chown "$CLAWCODE_USER:$CLAWCODE_USER" /etc/clawcode/env
  fi

  systemctl daemon-reload
  ok "Systemd service installed"
}

# --- Create workspace directories ---
setup_workspaces() {
  info "Creating workspace directories..."

  WORKSPACE_ROOT="/home/${CLAWCODE_USER}/workspaces"
  mkdir -p "$WORKSPACE_ROOT"
  mkdir -p "/home/${CLAWCODE_USER}/.clawcode/manager"
  chown -R "$CLAWCODE_USER:$CLAWCODE_USER" "/home/${CLAWCODE_USER}"

  ok "Workspace directories created at ${WORKSPACE_ROOT}"
}

# --- Summary ---
print_summary() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  ClawCode installation complete"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Install dir:   ${CLAWCODE_DIR}"
  echo "  Config:        ${CLAWCODE_CONFIG}"
  echo "  Secrets:       /etc/clawcode/env"
  echo "  Service:       clawcode.service"
  echo "  User:          ${CLAWCODE_USER}"
  echo "  Workspaces:    /home/${CLAWCODE_USER}/workspaces"
  echo "  Log:           ${LOG_FILE}"
  echo ""
  echo "  Next steps:"
  echo "  1. Authenticate Claude:  sudo -u ${CLAWCODE_USER} claude login"
  echo "  2. Configure agents:     sudo editor ${CLAWCODE_CONFIG}"
  echo "  3. Start the daemon:     sudo systemctl start clawcode"
  echo "  4. Enable on boot:       sudo systemctl enable clawcode"
  echo "  5. View logs:            journalctl -u clawcode -f"
  echo ""
}

# --- Main ---
main() {
  echo ""
  echo "  ClawCode Installer"
  echo "  ==================="
  echo ""

  check_root
  preflight
  install_system_deps
  install_node
  install_claude_cli
  create_user
  install_clawcode
  setup_config
  setup_workspaces
  install_service
  print_summary
}

main "$@"
