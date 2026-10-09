import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const HOST = "speed.cloudflare.com";
const STREAMS = 6;
// First part of each transfer phase is TCP ramp-up; leaving it in under-reports fast links.
const WARMUP_MS = 1500;
export const PHASE_MS = { quick: 4000, full: 8000 } as const;
export type Mode = keyof typeof PHASE_MS;
const UP_CHUNK = Buffer.alloc(64 * 1024, 0x61);
// Small bodies keep upload acks frequent and out of sync across streams, so the live chart stays smooth.
const UP_BODY = 256 * 1024;
const DOWN_BODY = 4 * 1000 * 1000;

export type Phase = "idle" | "latency" | "download" | "upload" | "done" | "error";

export type Meta = { ip?: string; colo?: string; city?: string; isp?: string; server?: string };

export type Progress = {
  phase: Phase;
  phaseProgress: number;
  phaseMs?: number;
  pingMs?: number;
  jitterMs?: number;
  loadedPingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  downloadSeries: number[];
  uploadSeries: number[];
  meta: Meta;
  error?: string;
};

const agent = new https.Agent({ keepAlive: true, maxSockets: STREAMS + 2 });

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class RateLimited extends Error {}

function request(
  method: "GET" | "POST",
  path: string,
  opts: { signal?: AbortSignal; onData?: (n: number) => void; body?: number } = {},
): Promise<{ headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        path,
        method,
        agent,
        signal: opts.signal,
        headers: { "content-type": "application/octet-stream" },
      },
      (res) => {
        if ((res.statusCode ?? 200) >= 400) {
          res.resume();
          return reject(new HttpError(res.statusCode ?? 0));
        }
        res.on("data", (c: Buffer) => opts.onData?.(c.length));
        res.on("end", () => resolve({ headers: res.headers }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (method === "POST" && opts.body) writeBody(req, opts.body).catch(reject);
    else req.end();
  });
}

async function writeBody(req: ReturnType<typeof https.request>, total: number) {
  for (let sent = 0; sent < total; sent += UP_CHUNK.length) {
    if (req.destroyed) return;
    const ok = req.write(UP_CHUNK);
    if (!ok) await new Promise((r) => req.once("drain", r));
  }
  req.end();
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

let hostIp: string | undefined;

// TCP handshake time is one pure network RTT; HTTP timing includes Cloudflare worker time (20-100ms).
async function ping(signal: AbortSignal): Promise<number> {
  hostIp ??= (await dns.lookup(HOST)).address;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const sock = net.connect({ host: hostIp, port: 443, signal });
    sock.setTimeout(3000, () => sock.destroy(new Error("Ping timeout")));
    sock.once("connect", () => {
      resolve(performance.now() - start);
      sock.destroy();
    });
    sock.once("error", reject);
  });
}

async function measureLatency(signal: AbortSignal, onTick: (p: number) => void) {
  const r = await request("GET", "/__down?bytes=0", { signal }).catch(() => undefined);
  const h = r?.headers ?? {};
  const colo = String(h["cf-meta-colo"] ?? h["colo"] ?? "");
  const meta: Meta = {
    ip: String(h["cf-meta-ip"] ?? "") || undefined,
    colo,
    server: colo ? `Cloudflare ${colo}` : undefined,
  };
  const samples: number[] = [];
  const n = 20;
  for (let i = 0; i < n; i++) {
    samples.push(await ping(signal));
    onTick((i + 1) / n);
  }
  const jitter = samples.slice(1).reduce((a, x, i) => a + Math.abs(x - samples[i]), 0) / (samples.length - 1);
  return { pingMs: median(samples), jitterMs: jitter, meta };
}

async function measureThroughput(
  kind: "download" | "upload",
  phaseMs: number,
  signal: AbortSignal,
  onSample: (mbps: number | undefined, progress: number, steady?: number) => void,
  onLoadedPing?: (ms: number) => void,
) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal.addEventListener("abort", abort);

  let bytes = 0;
  let steadyBytes = 0;
  const start = performance.now();
  const count = (n: number) => {
    bytes += n;
    if (performance.now() - start > WARMUP_MS) steadyBytes += n;
  };

  let rateLimited = false;
  const stream = async (_: unknown, i: number) => {
    await new Promise((r) => setTimeout(r, i * 120));
    while (!ctrl.signal.aborted) {
      try {
        // Cloudflare answers 429 for large single downloads once an IP has run several tests; small requests last longer.
        if (kind === "download")
          await request("GET", `/__down?bytes=${DOWN_BODY}`, { signal: ctrl.signal, onData: count });
        // Socket write callbacks fire into a multi-MB kernel buffer, so only count bytes the server acknowledged.
        else await request("POST", "/__up", { signal: ctrl.signal, body: UP_BODY }).then(() => count(UP_BODY));
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof HttpError && e.status === 429) {
          rateLimited = true;
          return ctrl.abort();
        }
      }
    }
  };

  const loaded: number[] = [];
  const pinger = async () => {
    while (onLoadedPing && !ctrl.signal.aborted) {
      try {
        loaded.push(await ping(ctrl.signal));
        onLoadedPing(median(loaded));
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  let lastBytes = 0;
  let lastT = start;
  const window: number[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    const inst = ((bytes - lastBytes) * 8) / ((now - lastT) / 1000) / 1e6;
    lastBytes = bytes;
    lastT = now;
    if (now - start < WARMUP_MS || bytes === 0) return onSample(undefined, (now - start) / phaseMs);
    window.push(inst);
    if (window.length > 8) window.shift();
    // Chart gets the 2s rolling rate; the headline uses the steady average so it does not jump around.
    const steady = (steadyBytes * 8) / ((now - start - WARMUP_MS) / 1000) / 1e6;
    onSample(window.reduce((a, b) => a + b, 0) / window.length, Math.min(1, (now - start) / phaseMs), steady);
    if (now - start >= phaseMs) ctrl.abort();
  }, 250);

  await Promise.all([...Array.from({ length: STREAMS }, stream), pinger()]);
  clearInterval(timer);
  signal.removeEventListener("abort", abort);
  if (signal.aborted) throw new Error("Cancelled");
  if (rateLimited) throw new RateLimited();

  const steadySec = (performance.now() - start - WARMUP_MS) / 1000;
  return { mbps: (steadyBytes * 8) / steadySec / 1e6, loadedPingMs: loaded.length ? median(loaded) : undefined };
}

// Apple's built-in test, used when Cloudflare rate limits this IP. It only reports at the end.
function appleTest(signal: AbortSignal, args: string[]): Promise<{ down?: number; up?: number }> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/networkQuality", ["-c", "-s", "-M", "15", ...args], { signal }, (err, out) => {
      if (err) return reject(signal.aborted ? new Error("Cancelled") : err);
      try {
        const j = JSON.parse(out) as { dl_throughput?: number; ul_throughput?: number };
        resolve({ down: j.dl_throughput && j.dl_throughput / 1e6, up: j.ul_throughput && j.ul_throughput / 1e6 });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function lookupIsp(): Promise<{ isp?: string; ip?: string }> {
  try {
    const res = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(4000) });
    const j = (await res.json()) as { org?: string; ip?: string };
    return { isp: j.org?.replace(/^AS\d+\s+/, ""), ip: j.ip };
  } catch {
    return {};
  }
}

export async function runSpeedTest(
  signal: AbortSignal,
  emit: (p: Progress) => void,
  mode: Mode = "full",
): Promise<Progress> {
  const phaseMs = PHASE_MS[mode];
  const state: Progress = {
    phase: "latency",
    phaseProgress: 0,
    phaseMs,
    downloadSeries: [],
    uploadSeries: [],
    meta: {},
  };
  const push = (patch: Partial<Progress>) => {
    Object.assign(state, patch);
    emit({ ...state, downloadSeries: [...state.downloadSeries], uploadSeries: [...state.uploadSeries] });
  };

  const isp = lookupIsp();
  push({});
  const lat = await measureLatency(signal, (p) => push({ phaseProgress: p }));
  push({ pingMs: lat.pingMs, jitterMs: lat.jitterMs, meta: lat.meta });
  isp.then((r) => push({ meta: { ...state.meta, isp: r.isp, ip: state.meta.ip ?? r.ip } }));

  // Fake progress while networkQuality runs, since it prints nothing until it finishes.
  const appleFallback = async (phase: "download" | "upload") => {
    push({ phase, phaseProgress: 0, meta: { ...state.meta, server: "Apple (Cloudflare rate limited)" } });
    const t0 = Date.now();
    const tick = setInterval(() => push({ phaseProgress: Math.min(0.95, (Date.now() - t0) / 30000) }), 500);
    try {
      return await appleTest(signal, phase === "upload" ? ["-d"] : []);
    } finally {
      clearInterval(tick);
    }
  };

  push({ phase: "download", phaseProgress: 0 });
  try {
    const down = await measureThroughput(
      "download",
      phaseMs,
      signal,
      (mbps, p, steady) => {
        if (mbps !== undefined) state.downloadSeries.push(mbps);
        push({ downloadMbps: steady ?? state.downloadMbps, phaseProgress: p });
      },
      (ms) => push({ loadedPingMs: ms }),
    );
    push({ downloadMbps: down.mbps, loadedPingMs: down.loadedPingMs });
  } catch (e) {
    if (!(e instanceof RateLimited)) throw e;
    const r = await appleFallback("download");
    push({
      downloadMbps: r.down,
      uploadMbps: r.up,
      phase: "done",
      phaseProgress: 1,
      meta: { ...state.meta, isp: (await isp).isp },
    });
    return state;
  }

  push({ phase: "upload", phaseProgress: 0 });
  try {
    const up = await measureThroughput("upload", phaseMs, signal, (mbps, p, steady) => {
      if (mbps !== undefined) state.uploadSeries.push(mbps);
      push({ uploadMbps: steady ?? state.uploadMbps, phaseProgress: p });
    });
    push({ uploadMbps: up.mbps });
  } catch (e) {
    if (!(e instanceof RateLimited)) throw e;
    push({ uploadMbps: (await appleFallback("upload")).up });
  }
  push({ phase: "done", phaseProgress: 1, meta: { ...state.meta, isp: (await isp).isp } });
  return state;
}
