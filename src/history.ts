import { LocalStorage } from "@raycast/api";
import type { Progress } from "./engine";
import type { LocalInfo } from "./network";

export { fmtMbps, fmtMs, summary } from "./format";

export type Result = {
  at: string;
  downloadMbps?: number;
  uploadMbps?: number;
  pingMs?: number;
  jitterMs?: number;
  loadedPingMs?: number;
  isp?: string;
  colo?: string;
  kind?: string;
};

const KEY = "history";
const MAX = 200;

export async function loadHistory(): Promise<Result[]> {
  const raw = await LocalStorage.getItem<string>(KEY);
  return raw ? (JSON.parse(raw) as Result[]) : [];
}

export async function saveResult(p: Progress, local?: LocalInfo): Promise<Result[]> {
  const result: Result = {
    at: new Date().toISOString(),
    downloadMbps: p.downloadMbps,
    uploadMbps: p.uploadMbps,
    pingMs: p.pingMs,
    jitterMs: p.jitterMs,
    loadedPingMs: p.loadedPingMs,
    isp: p.meta.isp,
    colo: p.meta.colo,
    kind: local?.kind,
  };
  const next = [result, ...(await loadHistory())].slice(0, MAX);
  await LocalStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
