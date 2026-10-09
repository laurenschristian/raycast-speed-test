type Measured = { downloadMbps?: number; uploadMbps?: number; pingMs?: number; jitterMs?: number };

export const fmtMbps = (v?: number) => (v === undefined ? "-" : v >= 100 ? v.toFixed(0) : v.toFixed(1));
export const fmtMs = (v?: number) => (v === undefined ? "-" : v >= 100 ? v.toFixed(0) : v.toFixed(1));

export const summary = (r: Pick<Measured, "downloadMbps" | "uploadMbps" | "pingMs" | "jitterMs">) =>
  `Download ${fmtMbps(r.downloadMbps)} Mbps · Upload ${fmtMbps(r.uploadMbps)} Mbps · Ping ${fmtMs(r.pingMs)} ms · Jitter ${fmtMs(r.jitterMs)} ms`;
