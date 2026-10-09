import type { Progress } from "./engine";
import { fmtMbps, fmtMs } from "./format";
import type { Result } from "./history";
import { type LocalInfo, signalQuality } from "./network";

export type Theme = "dark" | "light";

const W = 1000;
const GAP = 16;

const palette = {
  dark: {
    text: "#F5F7FA",
    muted: "#8B93A1",
    faint: "#454B57",
    card: "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.07)",
    accent: "#5B9BFF",
  },
  light: {
    text: "#111827",
    muted: "#6B7280",
    faint: "#C4C9D2",
    card: "rgba(0,0,0,0.03)",
    border: "rgba(0,0,0,0.07)",
    accent: "#2563EB",
  },
};

const FONT = `font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif"`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Waveform-style bufferbloat grade from latency increase under load.
export function bloatGrade(idle?: number, loaded?: number) {
  if (idle === undefined || loaded === undefined) return undefined;
  const d = Math.max(0, loaded - idle);
  const grade = d < 5 ? "A+" : d < 30 ? "A" : d < 60 ? "B" : d < 200 ? "C" : d < 400 ? "D" : "F";
  return { delta: d, grade };
}

export function useCases(p: Pick<Result, "downloadMbps" | "uploadMbps" | "pingMs" | "jitterMs">) {
  const { downloadMbps: d = 0, uploadMbps: u = 0, pingMs: l = 999, jitterMs: j = 999 } = p;
  return [
    { label: "Browsing", ok: d >= 5 },
    { label: "4K streaming", ok: d >= 25 },
    { label: "Video calls", ok: d >= 10 && u >= 5 && l < 100 },
    { label: "Gaming", ok: l < 40 && j < 15 },
    { label: "Large uploads", ok: u >= 50 },
  ];
}

export function smoothPath(pts: (readonly [number, number])[]) {
  if (pts.length === 1) pts = [pts[0], [pts[0][0] + 1, pts[0][1]]];
  // Catmull-Rom to cubic bezier.
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const [p1, p2] = [pts[i], pts[i + 1]];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function sparkline(series: number[], x0: number, x1: number, yTop: number, yBot: number, total: number) {
  if (!series.length) return undefined;
  const max = Math.max(...series) * 1.15;
  const step = (x1 - x0) / Math.max(1, total - 1);
  const pts = series.map((v, i) => [x0 + i * step, yBot - (v / max) * (yBot - yTop)] as const);
  const line = smoothPath(pts);
  const lastX = Math.max(x0 + (series.length - 1) * step, x0 + 1);
  return { line, area: `${line} L${lastX.toFixed(1)},${yBot} L${x0},${yBot} Z` };
}

// 2px inset so card strokes on the outer edge are not clipped.
const svgDoc = (h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 4}" height="${h + 4}" viewBox="-2 -2 ${W + 4} ${h + 4}">${body}</svg>`;

export function renderSvg(p: Progress, theme: Theme, local: LocalInfo, prev?: Result) {
  const c = palette[theme];
  const done = p.phase === "done";
  const out: string[] = [
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.32"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></linearGradient></defs>`,
  ];
  const text = (x: number, y: number, s: string, size: number, fill: string, extra = "") =>
    `<text x="${x}" y="${y}" ${FONT} font-size="${size}" fill="${fill}" ${extra}>${s}</text>`;
  const card = (x: number, y: number, w: number, h: number, active = false) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${c.card}" stroke="${active ? c.accent : c.border}" stroke-width="${active ? 2 : 1}"/>`;

  // Row 1: download and upload, mirrored.
  const hw = (W - GAP) / 2;
  const hh = 182;
  const expected = Math.round(((p.phaseMs ?? 8000) - 1500) / 250);
  const heroes = [
    { key: "download", label: "Download", v: p.downloadMbps, s: p.downloadSeries, prev: prev?.downloadMbps },
    { key: "upload", label: "Upload", v: p.uploadMbps, s: p.uploadSeries, prev: prev?.uploadMbps },
  ] as const;
  heroes.forEach((h, i) => {
    const x = i * (hw + GAP);
    const cx = x + hw / 2;
    const active = p.phase === h.key;
    const finished = done || (h.key === "download" && p.phase === "upload");
    out.push(`<clipPath id="c${i}"><rect x="${x}" y="0" width="${hw}" height="${hh}" rx="18"/></clipPath>`);
    out.push(card(x, 0, hw, hh, active));
    out.push(
      text(
        cx,
        34,
        `${h.label}${active ? " · testing" : ""}`,
        17,
        active ? c.accent : c.muted,
        `text-anchor="middle" font-weight="500"`,
      ),
      text(
        cx,
        98,
        fmtMbps(h.v),
        68,
        h.v === undefined ? c.faint : c.text,
        `text-anchor="middle" font-weight="600" letter-spacing="-2"`,
      ),
    );
    const d = done && h.v !== undefined && h.prev ? ((h.v - h.prev) / h.prev) * 100 : undefined;
    const sub = d !== undefined && Math.abs(d) >= 1 ? `Mbps · ${d > 0 ? "+" : ""}${d.toFixed(0)}% vs last` : "Mbps";
    out.push(text(cx, 126, sub, 16, c.muted, `text-anchor="middle"`));
    const sp = sparkline(h.s, x, x + hw, 138, hh, finished ? h.s.length : Math.max(expected, h.s.length));
    if (sp) {
      out.push(
        `<g clip-path="url(#c${i})"><path d="${sp.area}" fill="url(#fill)"/><path d="${sp.line}" fill="none" stroke="${c.accent}" stroke-width="2.5" stroke-linecap="round"/></g>`,
      );
    }
    if (active) {
      out.push(
        `<g clip-path="url(#c${i})"><rect x="${x}" y="${hh - 4}" width="${(hw * Math.min(1, p.phaseProgress)).toFixed(1)}" height="4" fill="${c.accent}"/></g>`,
      );
    }
  });

  // Row 2: four latency tiles.
  const y2 = hh + GAP;
  const tw = (W - 3 * GAP) / 4;
  const th = 88;
  const bloat = bloatGrade(p.pingMs, p.loadedPingMs);
  const tiles = [
    { label: "Ping", value: fmtMs(p.pingMs), unit: "ms", active: p.phase === "latency" },
    { label: "Jitter", value: fmtMs(p.jitterMs), unit: "ms", active: p.phase === "latency" },
    { label: "Under load", value: bloat ? `+${fmtMs(bloat.delta)}` : "-", unit: "ms", active: p.phase === "download" },
    { label: "Bufferbloat", value: bloat?.grade ?? "-", unit: "", active: false },
  ];
  tiles.forEach((t, i) => {
    const x = i * (tw + GAP);
    const cx = x + tw / 2;
    const empty = t.value === "-";
    const unit =
      t.unit && !empty ? `<tspan dx="5" font-size="17" font-weight="500" fill="${c.muted}">${t.unit}</tspan>` : "";
    out.push(
      card(x, y2, tw, th, t.active),
      text(cx, y2 + 32, t.label, 15, c.muted, `text-anchor="middle" font-weight="500"`),
      text(cx, y2 + 67, `${t.value}${unit}`, 28, empty ? c.faint : c.text, `text-anchor="middle" font-weight="600"`),
    );
  });

  // Row 3: connection details, two mirrored columns.
  const y3 = y2 + th + GAP;
  const rowH = 27;
  const w = local.wifi;
  const band = w?.channel?.match(/(\d+(?:\.\d+)?GHz)/)?.[1];
  const left: [string, string | undefined][] = [
    ["Server", p.meta.server],
    ["Provider", p.meta.isp],
    ["Public IP", p.meta.ip],
    ["DNS", local.dns],
  ];
  const right: [string, string | undefined][] = [
    ["Connection", [local.kind, band, w?.phy].filter(Boolean).join(" · ") || undefined],
    [
      "Signal",
      w?.signal !== undefined ? `${w.signal} dBm · ${signalQuality(w.signal)}` : local.kind ? "Wired" : undefined,
    ],
    ["Link rate", w?.rate ? `${w.rate} Mbps` : undefined],
    ["Local IP", local.localIp],
  ];
  const ch = rowH * 4 + 22;
  out.push(
    card(0, y3, W, ch),
    `<line x1="${W / 2}" x2="${W / 2}" y1="${y3 + 20}" y2="${y3 + ch - 20}" stroke="${c.border}"/>`,
  );
  [left, right].forEach((col, ci) => {
    const x0 = ci * (W / 2) + 28;
    const x1 = (ci + 1) * (W / 2) - 28;
    col.forEach(([k, v], ri) => {
      const y = y3 + 30 + ri * rowH;
      out.push(
        text(x0, y, k, 16, c.muted),
        text(x1, y, esc(clip(v ?? "-", 30)), 16, v ? c.text : c.faint, `text-anchor="end" font-weight="500"`),
      );
    });
  });

  // Row 4: what the connection handles, equal-width chips.
  const y4 = y3 + ch + GAP;
  const cases = useCases(p);
  const cw = (W - (cases.length - 1) * 10) / cases.length;
  cases.forEach((u, i) => {
    const x = i * (cw + 10);
    const on = done && u.ok;
    out.push(
      `<rect x="${x}" y="${y4}" width="${cw}" height="38" rx="19" fill="${on ? c.accent : c.card}" fill-opacity="${on ? 0.14 : 1}" stroke="${on ? c.accent : c.border}" stroke-opacity="${on ? 0.5 : 1}"/>`,
      text(
        x + cw / 2,
        y4 + 25,
        `${done ? (u.ok ? "✓ " : "✕ ") : ""}${u.label}`,
        16,
        on ? c.accent : done ? c.muted : c.faint,
        `text-anchor="middle" font-weight="500"`,
      ),
    );
  });

  return svgDoc(y4 + 38, out.join(""));
}

export function renderTrend(history: Result[], theme: Theme, highlight?: string) {
  const c = palette[theme];
  const runs = [...history].reverse().slice(-40);
  const H = 420;
  if (runs.length < 2) {
    return svgDoc(
      H,
      `<text x="${W / 2}" y="${H / 2}" ${FONT} font-size="20" fill="${c.muted}" text-anchor="middle">Run a few tests to see a trend</text>`,
    );
  }
  const peak = Math.max(...runs.map((r) => Math.max(r.downloadMbps ?? 0, r.uploadMbps ?? 0)));
  const [x0, x1, top, bot] = [24, W - 24, 70, H - 40];
  const xs = (i: number) => x0 + (i / (runs.length - 1)) * (x1 - x0);
  const ys = (v: number) => bot - (v / (peak * 1.15)) * (bot - top);
  const halo = theme === "dark" ? "#1C1C1E" : "#FFFFFF";
  const out: string[] = [
    `<defs><linearGradient id="tf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.28"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></linearGradient></defs>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="${c.card}" stroke="${c.border}"/>`,
    `<text x="24" y="40" ${FONT} font-size="18" font-weight="500" fill="${c.muted}">Last ${runs.length} runs</text>`,
    `<line x1="${W - 250}" x2="${W - 226}" y1="34" y2="34" stroke="${c.accent}" stroke-width="2.5"/><text x="${W - 218}" y="40" ${FONT} font-size="16" fill="${c.muted}">Download</text>`,
    `<line x1="${W - 124}" x2="${W - 100}" y1="34" y2="34" stroke="${c.accent}" stroke-width="2.5" stroke-dasharray="4 4"/><text x="${W - 92}" y="40" ${FONT} font-size="16" fill="${c.muted}">Upload</text>`,
  ];
  for (const f of [0.5, 1]) {
    const y = ys(peak * f);
    out.push(
      `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${c.border}" stroke-dasharray="4 6"/>`,
      `<text x="${x1}" y="${y - 6}" ${FONT} font-size="13" fill="${c.faint}" text-anchor="end">${Math.round(peak * f)}</text>`,
    );
  }
  const down = smoothPath(runs.map((r, i) => [xs(i), ys(r.downloadMbps ?? 0)] as const));
  const up = smoothPath(runs.map((r, i) => [xs(i), ys(r.uploadMbps ?? 0)] as const));
  out.push(
    `<path d="${down} L${x1},${bot} L${x0},${bot} Z" fill="url(#tf)"/>`,
    `<path d="${down}" fill="none" stroke="${c.accent}" stroke-width="2.5"/>`,
    `<path d="${up}" fill="none" stroke="${c.accent}" stroke-width="2.5" stroke-dasharray="6 6" opacity="0.8"/>`,
  );
  const hi = runs.findIndex((r) => r.at === highlight);
  if (hi >= 0) {
    const r = runs[hi];
    out.push(
      `<line x1="${xs(hi)}" x2="${xs(hi)}" y1="${top - 10}" y2="${bot}" stroke="${c.muted}" stroke-opacity="0.4"/>`,
      `<circle cx="${xs(hi)}" cy="${ys(r.downloadMbps ?? 0)}" r="6" fill="${c.accent}" stroke="${halo}" stroke-width="2"/>`,
      `<circle cx="${xs(hi)}" cy="${ys(r.uploadMbps ?? 0)}" r="6" fill="${c.accent}" stroke="${halo}" stroke-width="2"/>`,
    );
  }
  return svgDoc(H, out.join(""));
}

export const toDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
