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
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { URL } from 'node:url';

const URL_BASE = (process.env.QENTRA_URL || 'https://api.qentra.it.com').replace(/\/$/, '');
const TOKEN = process.env.QENTRA_TOKEN || '';
const HOST_NAME = process.env.HOST_NAME || os.hostname();
const REPORT_MS = (Number(process.env.REPORT_SECONDS) || 30) * 1000;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const VERSION = '0.7.1';

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

// IO wait — the share of time the CPU sat idle with a disk read/write
// outstanding. High iowait with low CPU is the signature of storage being the
// bottleneck, which CPU% alone can't tell you. os.cpus() doesn't expose it, so
// read /proc/stat directly: fields after "cpu" are user nice system idle iowait...
// They're cumulative counters, so this needs a delta over a short window, the
// same way cpuPercent works.
function procStatCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    if (!f.length || f.some(Number.isNaN)) return null;
    return { iowait: f[4] || 0, total: f.reduce((sum, v) => sum + v, 0) };
  } catch { return null; }
}
async function iowaitPercent() {
  const a = procStatCpu();
  if (!a) return null; // non-Linux or /proc unavailable — report nothing, not zero
  await new Promise((r) => setTimeout(r, 300));
  const b = procStatCpu();
  if (!b) return null;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((b.iowait - a.iowait) / totalDelta) * 100));
}

// Hottest thermal zone in °C. Present on bare metal and some hypervisors;
// most cloud VMs expose nothing, which stays null rather than a fake 0.
function hostTempC() {
  try {
    const base = '/sys/class/thermal';
    const temps = [];
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('thermal_zone')) continue;
      try {
        const raw = Number(fs.readFileSync(`${base}/${dir}/temp`, 'utf8').trim());
        // Kernel reports millidegrees; a few drivers report degrees directly.
        const c = raw > 1000 ? raw / 1000 : raw;
        if (Number.isFinite(c) && c > 0 && c < 150) temps.push(c);
      } catch { /* zone unreadable — skip it */ }
    }
    return temps.length ? Math.max(...temps) : null;
  } catch { return null; }
}

// Network THROUGHPUT. /proc/net/dev gives lifetime byte counters, which say
// nothing about current load on their own — a box up for a month shows a huge
// number while idle. Convert to bytes/sec against the previous tick; the first
// tick after start has no baseline and reports null rather than a spike.
let lastNet = null;
function netThroughput(now) {
  const cur = netTotals();
  if (cur.rx == null) return { rxBps: null, txBps: null };
  const prev = lastNet;
  lastNet = { rx: cur.rx, tx: cur.tx, at: now };
  if (!prev) return { rxBps: null, txBps: null };
  const secs = (now - prev.at) / 1000;
  if (secs <= 0) return { rxBps: null, txBps: null };
  // A counter that went backwards means a reboot or interface reset — skip
  // rather than emit a negative or absurd rate.
  if (cur.rx < prev.rx || cur.tx < prev.tx) return { rxBps: null, txBps: null };
  return {
    rxBps: Math.round((cur.rx - prev.rx) / secs),
    txBps: Math.round((cur.tx - prev.tx) / secs),
  };
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

// A stable identity for THIS machine, independent of the reported hostname.
// Without it the same box registers twice when it's monitored under two names
// (e.g. once via docker-compose with HOST_NAME set, once via the systemd
// installer defaulting to `hostname -s`), and the UI has no way to know they
// are one machine.
function machineId() {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch { /* try the next path */ }
  }
  return null;
}
const MACHINE_ID = machineId();

async function collectHost() {
  const mem = { total: os.totalmem(), free: os.freemem() };
  const memUsed = mem.total - mem.free;
  const disk = diskUsage();
  const net = netTotals();
  const throughput = netThroughput(Date.now());
  const load = os.loadavg();
  return {
    host: HOST_NAME,
    agentVersion: VERSION,
    cpuPct: await cpuPercent(),
    iowaitPct: await iowaitPercent(),
    tempC: hostTempC(),
    cpuCores: os.cpus().length || null,
    memPct: mem.total ? (memUsed / mem.total) * 100 : null,
    memUsedBytes: memUsed,
    memTotalBytes: mem.total,
    swapPct: null, // not read on this pass — /proc/meminfo SwapTotal/SwapFree, left null rather than guessed
    diskPct: disk.pct,
    diskUsedBytes: disk.usedBytes,
    diskTotalBytes: disk.totalBytes,
    loadAvg1: load[0], loadAvg5: load[1], loadAvg15: load[2],
    netRxBytes: net.rx, netTxBytes: net.tx,
    netRxBps: throughput.rxBps, netTxBps: throughput.txBps,
    uptimeSec: os.uptime(),
    os: `${os.type()} ${os.release()}`,
    kernel: os.release(),
    machineId: MACHINE_ID,
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
    let startedAt = null, createdAt = null, persistentVolumes = [];
    try {
      const inspect = await dockerGet(`/containers/${c.Id}/json`);
      health = inspect.State?.Health?.Status || null;
      restartCount = inspect.RestartCount ?? null;
      exitCode = inspect.State?.ExitCode ?? null;
      oomKilled = !!inspect.State?.OOMKilled;
      memLimitBytes = inspect.HostConfig?.Memory > 0 ? inspect.HostConfig.Memory : null;
      // Docker returns the zero time ("0001-01-01T00:00:00Z") for StartedAt on
      // a container that has never run — treat that as no data, not an age of
      // 2000+ years.
      const rawStarted = inspect.State?.StartedAt;
      if (rawStarted && !rawStarted.startsWith('0001-01-01')) startedAt = rawStarted;
      createdAt = inspect.Created || null;
      // Persistent storage is the STRUCTURAL signal for "this holds state" —
      // far more reliable than matching image names, which can never cover
      // every database, queue or store a customer might run. Read-only mounts
      // and the usual config/socket paths are excluded: mounting the Docker
      // socket or a certificate does not make a container stateful.
      persistentVolumes = (inspect.Mounts || [])
        .filter((m) => m.RW !== false)
        .filter((m) => m.Type === 'volume' || m.Type === 'bind')
        .map((m) => m.Destination)
        .filter((d) => d && !/^\/(etc|run|var\/run|sys|proc|dev|tmp)(\/|$)/.test(d) && !/\.sock$/.test(d))
        // A single bind-mounted config file is not state. Seen in the field:
        // `/livekit.yaml` and `/egress.yaml` were marking stateless services as
        // data-holding, which would put them under rules meant for databases.
        // Extension-based, since a mounted file's PATH is all Docker gives us.
        .filter((d) => !/\.(ya?ml|conf|cfg|ini|toml|json|properties|env|pem|crt|key|cert|pub)$/i.test(d));
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
      startedAt, createdAt, persistentVolumes,
    });
  }
  return out;
}

// ── Container logs ───────────────────────────────────────────────────────────
//
// Tail each running container since the last tick and ship what we find to the
// SAME /ingest/logs pipeline the Kubernetes agent uses, with cluster=<host> and
// container=<name>. That reuses log search, error templating and fingerprinting
// wholesale rather than inventing a second, parallel log store.
//
// Requires the token to carry logs:write as well as infra:write. Tokens minted
// before that change only have infra:write, so a 403 disables log shipping for
// the process lifetime instead of retrying (and log-spamming) every 30s.
let logsDisabled = false;
const lastLogAt = new Map(); // container id -> unix seconds of the last line shipped
// How far back to reach on first sight of a container. Matches the shortest
// range the UI offers (1h), so a freshly installed agent has something to show
// immediately instead of an empty pane.
const LOG_BACKFILL_SEC = 3600;

// Docker multiplexes stdout/stderr into frames when the container has no TTY:
// [stream(1), 0,0,0, size(4 BE)] then `size` payload bytes. A TTY container
// streams raw. Detect by the frame header shape rather than inspecting config.
function demuxDockerLogs(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    if ((type === 1 || type === 2) && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
      const size = buf.readUInt32BE(i + 4);
      if (size > buf.length - (i + 8)) break; // truncated frame — leave it for next tick
      out.push(buf.slice(i + 8, i + 8 + size).toString('utf8'));
      i += 8 + size;
    } else {
      return buf.toString('utf8'); // raw TTY stream
    }
  }
  return out.join('');
}

// Level inferred from the line itself — these are arbitrary application logs,
// so there's no structured level to read. Only ERROR/WARN survive into the
// entries table server-side, so a wrong guess costs recall, not correctness.
// Pull an HTTP status out of an access-log line. Handles JSON loggers
// (Caddy/nginx json, `"status":500`) and the common combined/CLF shape
// (`"GET /x HTTP/1.1" 500 1234`). Returns null when the line isn't a request
// log at all — most lines aren't, and guessing would manufacture alerts.
function inferHttpStatus(msg) {
  const j = msg.match(/"status"\s*:\s*(\d{3})/);
  if (j) return Number(j[1]);
  const clf = msg.match(/"[A-Z]{3,7} [^"]*HTTP\/[\d.]+"\s+(\d{3})\b/);
  if (clf) return Number(clf[1]);
  return null;
}

function inferLevel(msg) {
  const s = msg.slice(0, 400).toUpperCase();
  if (/\b(FATAL|PANIC)\b/.test(s)) return 'FATAL';
  if (/\b(ERROR|ERR|EXCEPTION|TRACEBACK|FAILED|FAILURE)\b/.test(s)) return 'ERROR';
  if (/\bWARN(ING)?\b/.test(s)) return 'WARN';
  return 'INFO';
}

function dockerGetRaw(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET', timeout: 10000 }, (res) => {
      const chunks = [];
      let len = 0;
      res.on('data', (c) => {
        chunks.push(c); len += c.length;
        if (len > 2e6) req.destroy(); // cap a single container's tail at ~2 MB
      });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`docker ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker socket timeout')));
    req.end();
  });
}

async function collectLogs(list) {
  if (logsDisabled) return [];
  const logs = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const c of list) {
    if (c.State !== 'running') continue;
    const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
    // First sight of a container, backfill a window rather than starting from
    // "now". Starting at now meant a container that logs infrequently (an
    // hourly scheduler, say) showed NOTHING in the UI until it next spoke —
    // up to an hour of "no logs collected" on a container with hundreds of
    // lines of history sitting right there. Capped by `tail` so a chatty
    // container can't dump its whole ring buffer on the first tick.
    const seen = lastLogAt.get(c.Id);
    const since = seen ?? nowSec - LOG_BACKFILL_SEC;
    const tail = seen ? 200 : 400;
    let raw;
    try {
      raw = await dockerGetRaw(`/containers/${c.Id}/logs?stdout=1&stderr=1&timestamps=1&since=${since}&tail=${tail}`);
    } catch { continue; }
    lastLogAt.set(c.Id, nowSec);
    const text = demuxDockerLogs(raw);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // `timestamps=1` prefixes each line with an RFC3339 stamp.
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s?([\s\S]*)$/);
      const ts = m ? m[1] : undefined;
      const message = (m ? m[2] : line).trim();
      if (!message) continue;
      const http = inferHttpStatus(message);
      // A 5xx is an error even when the line itself is logged at INFO — which
      // is exactly how most access logs record them.
      const level = http >= 500 ? 'ERROR' : inferLevel(message);
      logs.push({ ts, level, http, message: message.slice(0, 4000), container: name, service: name });
      if (logs.length >= 1500) return logs; // per-tick ceiling across all containers
    }
  }
  return logs;
}

// ── Ship to Qentra ───────────────────────────────────────────────────────────

function postJson(apiPath, obj, onStatus) {
  const gz = zlib.gzipSync(JSON.stringify(obj));
  const u = new URL(`${URL_BASE}${apiPath}`);
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve) => {
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Authorization: `Bearer ${TOKEN}` },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 64_000) body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) console.error(`[qentra-host-agent] ingest ${res.statusCode} (${apiPath})`);
        onStatus?.(res.statusCode);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('[qentra-host-agent] ingest error:', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(gz);
  });
}

// ── Self-update ─────────────────────────────────────────────────────────────
//
// Pull-only and consent-gated: the server never connects here. A pending job
// rides back on our own ingest response, we fetch the artifact, verify the
// sha256 the server published, and only then replace our own source. Anything
// that doesn't verify is reported and discarded — a bad or tampered artifact
// must never execute.
//
// Restart is systemd's job: we exit 0 after a successful swap and `Restart=always`
// brings us back on the new code. Inside Docker there's nothing sane to do —
// the image is immutable and /app isn't ours to write — so we decline and say so.
const IN_DOCKER = fs.existsSync('/.dockerenv');
const SELF_PATH = process.argv[1];
let updating = false;

function reportJob(jobId, status, detail) {
  return postJson(`/api/ingest/host/update-jobs/${jobId}`, { nodeName: HOST_NAME, status, ...(detail ? { detail } : {}) });
}

function download(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    lib.get(u, { timeout: 60_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      let len = 0;
      res.on('data', (c) => {
        chunks.push(c); len += c.length;
        if (len > 25e6) { res.destroy(); reject(new Error('artifact exceeds 25 MB')); }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function applyUpdate(update) {
  if (updating) return;
  updating = true;
  const { jobId, version, artifactUrl, sha256 } = update;
  try {
    await reportJob(jobId, 'acknowledged');

    if (IN_DOCKER) {
      await reportJob(jobId, 'failed', 'Running inside a container — its image is immutable. Pull the new image and recreate the container instead.');
      return;
    }

    await reportJob(jobId, 'downloading');
    const buf = await download(artifactUrl);

    const got = createHash('sha256').update(buf).digest('hex');
    if (got.toLowerCase() !== String(sha256).toLowerCase()) {
      await reportJob(jobId, 'failed', `Checksum mismatch — expected ${sha256}, got ${got}. Nothing was installed.`);
      return;
    }

    // Keep the running version so a bad build can be restored by hand.
    try { fs.copyFileSync(SELF_PATH, `${SELF_PATH}.bak`); } catch { /* best-effort */ }
    // Write beside the target then rename — a torn write must never leave a
    // half-file that systemd will try to execute.
    const tmp = `${SELF_PATH}.new`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, SELF_PATH);

    await reportJob(jobId, 'applied', `Updated ${VERSION} → ${version}; restarting.`);
    console.log(`[qentra-host-agent] updated ${VERSION} → ${version}, restarting`);
    setTimeout(() => process.exit(0), 500); // systemd Restart=always brings us back
  } catch (e) {
    await reportJob(jobId, 'failed', `Update to ${version} failed: ${e.message}`).catch(() => {});
    console.error('[qentra-host-agent] self-update failed:', e.message);
  } finally {
    updating = false;
  }
}

async function tick() {
  const hostData = await collectHost();
  const containers = await collectContainers();
  const res = await postJson('/api/ingest/host', { ...hostData, containers });
  if (res?.update?.jobId) applyUpdate(res.update).catch(() => {});

  let list = [];
  try { list = await dockerGet('/containers/json?all=false'); } catch { return; }
  const logs = await collectLogs(list);
  if (!logs.length) return;

  // Raw tail — every line, short retention, so the UI can show real
  // `docker logs` output. Uses infra:write like the metrics above.
  postJson('/api/ingest/container-logs', {
    host: HOST_NAME,
    lines: logs.map((l) => ({ container: l.container, at: l.ts, level: l.level, http: l.http, message: l.message })),
  });

  // Error/warning lines ALSO go to the shared log-analytics pipeline (grouping,
  // fingerprints, cross-cluster search). That one needs logs:write, which older
  // tokens lack — a 403 disables just this half, leaving the raw tail intact.
  if (logsDisabled) return;
  // Strip `http` when there's no status — the shared log pipeline's schema
  // takes a number or nothing, and a null would reject the whole batch.
  const errors = logs.filter((l) => l.level !== 'INFO')
    .map(({ http, ...rest }) => (http == null ? rest : { ...rest, http }));
  if (!errors.length) return;
  postJson('/api/ingest/logs', { source: { name: HOST_NAME, cluster: HOST_NAME, agentVersion: VERSION }, logs: errors }, (status) => {
    if (status === 403) {
      logsDisabled = true;
      console.error('[qentra-host-agent] log analytics disabled — token lacks logs:write. Raw container logs still work.');
    }
  });
}

console.log(`[qentra-host-agent] v${VERSION} → ${URL_BASE} (host=${HOST_NAME}, every ${REPORT_MS / 1000}s)`);
detectCloudProvider().then((info) => {
  cloudInfo = info;
  if (info.cloudProvider) console.log(`[qentra-host-agent] detected cloud: ${info.cloudProvider}${info.region ? ` (${info.region})` : ''}`);
  tick().catch((e) => console.error('[qentra-host-agent] tick failed:', e.message));
  setInterval(() => tick().catch((e) => console.error('[qentra-host-agent] tick failed:', e.message)), REPORT_MS);
});
