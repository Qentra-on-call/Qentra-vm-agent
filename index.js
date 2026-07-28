// Qentra Host + Docker agent — a small, stdlib-only collector for plain Linux
// hosts (EC2, bare metal, on-prem VMs — anything running Docker Compose, not
// necessarily Kubernetes). Reports host CPU/memory/disk/load/network and
// every Docker container's state/health/restarts/cpu/mem/net/blkio to Qentra
// every REPORT_SECONDS. Same design philosophy as the Kubernetes DaemonSet
// agent (cluster-agent's Node stdlib, no npm deps, bounded memory) — this is
// a SEPARATE agent, not an extension of that one, because it targets a
// different substrate: the Kubernetes agent is a Helm chart requiring a
// cluster API server; this one is a single Docker container with no such
// requirement, matching a plain Docker Compose host like this one.
//
//   QENTRA_URL       e.g. https://api.qentra.it.com   (required)
//   QENTRA_TOKEN     ApiToken with scope infra:write    (required)
//   HOST_NAME        stable name for this host (default: os.hostname())
//   REPORT_SECONDS   default 30
//   DOCKER_SOCKET    default /var/run/docker.sock
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { URL } from 'node:url';

const URL_BASE = (process.env.QENTRA_URL || 'https://api.qentra.it.com').replace(/\/$/, '');
const TOKEN = process.env.QENTRA_TOKEN || '';
const HOST_NAME = process.env.HOST_NAME || os.hostname();
const REPORT_MS = (Number(process.env.REPORT_SECONDS) || 30) * 1000;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const VERSION = '0.1.0';

if (!TOKEN) {
  console.error('[qentra-host-agent] QENTRA_TOKEN is required (an infra:write scoped token)');
  process.exit(1);
}

// ── Host metrics ─────────────────────────────────────────────────────────────

// CPU % via a short sample window: os.cpus() gives cumulative core times, so
// two reads REPORT_SAMPLE_MS apart and a delta gives real utilisation.
function cpuSnapshot() {
  return os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
}
async function cpuPercent() {
  const a = cpuSnapshot();
  await new Promise((r) => setTimeout(r, 300));
  const b = cpuSnapshot();
  let idleDelta = 0, totalDelta = 0;
  for (let i = 0; i < a.length; i++) {
    idleDelta += b[i].idle - a[i].idle;
    totalDelta += b[i].total - a[i].total;
  }
  return totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta))) : null;
}

// Disk usage of / via `df` — simplest reliable cross-distro reading without a
// native dependency. Best-effort: a missing/odd `df` output just omits disk fields.
function diskUsage() {
  try {
    const out = execSync('df -B1 /', { encoding: 'utf8', timeout: 5000 });
    const line = out.trim().split('\n')[1];
    const parts = line.split(/\s+/);
    const total = Number(parts[1]), used = Number(parts[2]);
    if (!total) return { usedBytes: null, totalBytes: null, pct: null };
    return { usedBytes: used, totalBytes: total, pct: (used / total) * 100 };
  } catch { return { usedBytes: null, totalBytes: null, pct: null }; }
}

// Cumulative network rx/tx bytes summed across all non-loopback interfaces,
// via /proc/net/dev (Linux-only — this agent targets Linux hosts).
function netTotals() {
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const m = line.trim().match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [iface, rest] = [m[1], m[2]];
      if (iface === 'lo') continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] || 0; tx += cols[8] || 0;
    }
    return { rx, tx };
  } catch { return { rx: null, tx: null }; }
}

async function collectHost() {
  const mem = { total: os.totalmem(), free: os.freemem() };
  const memUsed = mem.total - mem.free;
  const disk = diskUsage();
  const net = netTotals();
  const load = os.loadavg();
  return {
    host: HOST_NAME,
    agentVersion: VERSION,
    cpuPct: await cpuPercent(),
    memPct: mem.total ? (memUsed / mem.total) * 100 : null,
    memUsedBytes: memUsed,
    memTotalBytes: mem.total,
    swapPct: null, // not read on this pass — /proc/meminfo SwapTotal/SwapFree, left null rather than guessed
    diskPct: disk.pct,
    diskUsedBytes: disk.usedBytes,
    diskTotalBytes: disk.totalBytes,
    loadAvg1: load[0], loadAvg5: load[1], loadAvg15: load[2],
    netRxBytes: net.rx, netTxBytes: net.tx,
    uptimeSec: os.uptime(),
    os: `${os.type()} ${os.release()}`,
    kernel: os.release(),
    ...cloudInfo,
  };
}

// ── Cloud metadata (best-effort, detected once at startup) ──────────────────
//
// Bare metal, on-prem VMs and unrecognized hosts simply get no cloud fields —
// this agent works everywhere either way. All four providers' metadata
// services live at a link-local address the host can't route off-box, so a
// short timeout is enough to fail fast on non-cloud hosts instead of hanging.
function metaRequest(hostHeader, path, { headers = {}, method = 'GET', isHttps = false } = {}) {
  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const req = lib.request({ host: hostHeader, path, method, timeout: 400, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve(data) : reject(new Error(String(res.statusCode))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}
const metaGet = (host, path, headers) => metaRequest(host, path, { headers });

async function detectAws() {
  // IMDSv2 token fetch is a PUT, not a GET — everything after it is a GET.
  const token = await metaRequest('169.254.169.254', '/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' } }).catch(() => null);
  // Some AMIs disable IMDSv2 — fall back to the unauthenticated v1 path.
  const headers = token ? { 'X-aws-ec2-metadata-token': token } : {};
  const instanceType = await metaGet('169.254.169.254', '/latest/meta-data/instance-type', headers).catch(() => null);
  if (!instanceType) return null;
  const az = await metaGet('169.254.169.254', '/latest/meta-data/placement/availability-zone', headers).catch(() => null);
  return { cloudProvider: 'aws', instanceType, region: az ? az.replace(/[a-z]$/, '') : null };
}
async function detectAzure() {
  const body = await metaGet('169.254.169.254', '/metadata/instance?api-version=2021-02-01', { Metadata: 'true' }).catch(() => null);
  if (!body) return null;
  try {
    const j = JSON.parse(body).compute;
    return { cloudProvider: 'azure', instanceType: j?.vmSize || null, region: j?.location || null };
  } catch { return null; }
}
async function detectGcp() {
  const instanceType = await metaGet('metadata.google.internal', '/computeMetadata/v1/instance/machine-type', { 'Metadata-Flavor': 'Google' }).catch(() => null);
  if (!instanceType) return null;
  const zone = await metaGet('metadata.google.internal', '/computeMetadata/v1/instance/zone', { 'Metadata-Flavor': 'Google' }).catch(() => null);
  return { cloudProvider: 'gcp', instanceType: instanceType.split('/').pop(), region: zone ? zone.split('/').pop() : null };
}
async function detectDigitalOcean() {
  const body = await metaGet('169.254.169.254', '/metadata/v1.json').catch(() => null);
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    return { cloudProvider: 'digitalocean', instanceType: null, region: j?.region || null };
  } catch { return null; }
}
async function detectCloudProvider() {
  for (const detect of [detectAws, detectGcp, detectAzure, detectDigitalOcean]) {
    const result = await detect().catch(() => null);
    if (result) return result;
  }
  return { cloudProvider: null, instanceType: null, region: null };
}

let cloudInfo = { cloudProvider: null, instanceType: null, region: null };

// ── Docker metrics (Engine API over the Unix socket, no client library) ─────

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET', timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 20e6) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }
        else reject(new Error(`docker ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker socket timeout')));
    req.end();
  });
}

// One container's /stats (non-streaming) → cpu%/mem/net/blkio, computed the
// same way `docker stats` does (cpu delta against the PRECEDING sample the
// API itself returns, not a second call — non-streaming stats already embed
// precpu_stats for exactly this).
function computeCpuPct(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cores = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
    if (sysDelta > 0 && cpuDelta >= 0) return (cpuDelta / sysDelta) * cores * 100;
  } catch { /* fall through */ }
  return null;
}
function sumNet(networks) {
  let rx = 0, tx = 0;
  for (const n of Object.values(networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
  return { rx, tx };
}
function sumBlkio(blkio) {
  let read = 0, write = 0;
  for (const e of (blkio?.io_service_bytes_recursive || [])) {
    if (e.op === 'Read') read += e.value || 0;
    if (e.op === 'Write') write += e.value || 0;
  }
  return { read, write };
}

async function collectContainers() {
  let list;
  try { list = await dockerGet('/containers/json?all=true'); }
  catch (e) { console.error('[qentra-host-agent] docker list failed:', e.message); return []; }

  const out = [];
  for (const c of list) {
    const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
    const image = c.Image || null;
    const composeProject = c.Labels?.['com.docker.compose.project'] || null;
    const state = c.State || null;
    let health = null, restartCount = null, exitCode = null, oomKilled = false, memLimitBytes = null;
    try {
      const inspect = await dockerGet(`/containers/${c.Id}/json`);
      health = inspect.State?.Health?.Status || null;
      restartCount = inspect.RestartCount ?? null;
      exitCode = inspect.State?.ExitCode ?? null;
      oomKilled = !!inspect.State?.OOMKilled;
      memLimitBytes = inspect.HostConfig?.Memory > 0 ? inspect.HostConfig.Memory : null;
    } catch { /* best-effort — container may have exited between list and inspect */ }

    let cpuPct = null, memUsedBytes = null, net = { rx: null, tx: null }, blk = { read: null, write: null };
    if (state === 'running') {
      try {
        const stats = await dockerGet(`/containers/${c.Id}/stats?stream=false`);
        cpuPct = computeCpuPct(stats);
        memUsedBytes = stats.memory_stats?.usage ?? null;
        net = sumNet(stats.networks);
        blk = sumBlkio(stats.blkio_stats);
      } catch { /* stats can 404 briefly right after start — skip this cycle */ }
    }

    out.push({
      container: name, image, composeProject, state, health,
      restartCount, exitCode, oomKilled,
      cpuPct, memUsedBytes, memLimitBytes,
      netRxBytes: net.rx, netTxBytes: net.tx,
      blockReadBytes: blk.read, blockWriteBytes: blk.write,
    });
  }
  return out;
}

// ── Ship to Qentra ───────────────────────────────────────────────────────────

function postJson(apiPath, obj) {
  const gz = zlib.gzipSync(JSON.stringify(obj));
  const u = new URL(`${URL_BASE}${apiPath}`);
  const lib = u.protocol === 'http:' ? http : https;
  const req = lib.request(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Authorization: `Bearer ${TOKEN}` },
    timeout: 15000,
  }, (res) => {
    res.resume();
    if (res.statusCode < 200 || res.statusCode >= 300) console.error(`[qentra-host-agent] ingest ${res.statusCode}`);
  });
  req.on('error', (e) => console.error('[qentra-host-agent] ingest error:', e.message));
  req.on('timeout', () => req.destroy());
  req.end(gz);
}

async function tick() {
  const hostData = await collectHost();
  const containers = await collectContainers();
  postJson('/api/ingest/host', { ...hostData, containers });
}

console.log(`[qentra-host-agent] v${VERSION} → ${URL_BASE} (host=${HOST_NAME}, every ${REPORT_MS / 1000}s)`);
detectCloudProvider().then((info) => {
  cloudInfo = info;
  if (info.cloudProvider) console.log(`[qentra-host-agent] detected cloud: ${info.cloudProvider}${info.region ? ` (${info.region})` : ''}`);
  tick().catch((e) => console.error('[qentra-host-agent] tick failed:', e.message));
  setInterval(() => tick().catch((e) => console.error('[qentra-host-agent] tick failed:', e.message)), REPORT_MS);
});
