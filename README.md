# Qentra Linux Host + Docker Agent

A small, dependency-free agent for [Qentra](https://qentra.it.com) that reports
host-level metrics (CPU, memory, disk, load, network) and every running Docker
container's state, health, restarts, and resource usage — from any plain Linux
server. Bare metal, an on-prem VM, or a cloud instance; it auto-detects AWS,
Azure, GCP, or DigitalOcean at startup and tags itself accordingly.

Pure Node.js standard library — no npm dependencies, no client libraries.
Reads `/proc`, runs `df`, and talks to the Docker Engine API over its Unix
socket read-only. It never starts, stops, or execs anything in a container.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/JohnQentra/qentra-vm-agent/main/install.sh \
  | QENTRA_TOKEN=<your infra:write token> bash
```

Get a token from Qentra: **Infrastructure → + Add host → Generate token**.

This installs the agent as a systemd service (`qentra-vm-agent`) running under
a dedicated unprivileged system user, added to the `docker` group so it can
read container stats.

```bash
systemctl status qentra-vm-agent
journalctl -u qentra-vm-agent -f
```

## Configuration

Set via `/etc/qentra-vm-agent/env`, or as env vars at install time:

| Variable          | Default                     | Notes                                   |
|-------------------|------------------------------|------------------------------------------|
| `QENTRA_URL`      | `https://api.qentra.it.com`  |                                          |
| `QENTRA_TOKEN`    | *(required)*                 | An `ApiToken` with scope `infra:write`  |
| `HOST_NAME`       | this host's short hostname    | Stable identity across restarts          |
| `REPORT_SECONDS`  | `30`                          |                                          |
| `DOCKER_SOCKET`   | `/var/run/docker.sock`        | No effect if Docker isn't installed      |

## What it collects

**Host**: CPU %, memory used/total, disk used/total (`/`), 1/5/15m load
average, network rx/tx, uptime, OS/kernel, and (best-effort) which cloud
provider it's running on.

**Per container**: name, image, compose project, state, health status,
restart count, exit code, OOM-killed flag, CPU %, memory usage, network
rx/tx, and block I/O read/write — for every container Docker knows about,
running or not.

Nothing is ever written to — this agent only issues Docker Engine API `GET`
requests.
