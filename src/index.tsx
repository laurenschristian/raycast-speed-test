import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  environment,
  getPreferenceValues,
  Icon,
  Keyboard,
  showToast,
  Toast,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Mode, type Progress, runSpeedTest } from "./engine";
import History from "./history-view";
import { loadHistory, type Result, saveResult, summary } from "./history";
import { getLocalInfo, type LocalInfo } from "./network";
import { renderSvg, toDataUri } from "./render";

const initial: Progress = { phase: "idle", phaseProgress: 0, downloadSeries: [], uploadSeries: [], meta: {} };

const PHASE_LABEL: Record<Progress["phase"], string> = {
  idle: "Starting",
  latency: "Measuring latency",
  download: "Testing download",
  upload: "Testing upload",
  done: "Done",
  error: "Failed",
};

export default function Command() {
  const prefs = getPreferenceValues<{ mode: Mode }>();
  const [mode, setMode] = useState<Mode>(prefs.mode ?? "full");
  const [progress, setProgress] = useState<Progress>(initial);
  const [local, setLocal] = useState<LocalInfo>({});
  const [history, setHistory] = useState<Result[]>([]);
  const [runId, setRunId] = useState(0);
  const lastEmit = useRef({ t: 0, phase: "" });

  useEffect(() => {
    loadHistory().then(setHistory);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setProgress(initial);
    // Wi-Fi lookup takes a few seconds (system_profiler), so it runs alongside the test.
    const localInfo = getLocalInfo().then((l) => (setLocal(l), l));
    runSpeedTest(
      ctrl.signal,
      (p) => {
        // Throttle re-renders; the SVG is rebuilt on every update.
        const now = Date.now();
        if (now - lastEmit.current.t < 120 && p.phase === lastEmit.current.phase) return;
        lastEmit.current = { t: now, phase: p.phase };
        setProgress(p);
      },
      mode,
    )
      .then(async (p) => {
        setProgress(p);
        setHistory(await saveResult(p, await localInfo));
      })
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return;
        setProgress((p) => ({ ...p, phase: "error", error: e.message }));
        showToast({ style: Toast.Style.Failure, title: "Speed test failed", message: e.message });
      });
    return () => ctrl.abort();
  }, [runId]);

  const done = progress.phase === "done";
  const prev = done ? history[1] : history[0];
  const theme = environment.appearance === "light" ? "light" : "dark";
  const img = toDataUri(renderSvg(progress, theme, local, prev));
  const markdown = `![](${img}?raycast-width=740)${progress.error ? `\n\n**Error:** ${progress.error}` : ""}`;
  const pct =
    progress.phase === "download" || progress.phase === "upload" ? ` ${Math.round(progress.phaseProgress * 100)}%` : "";

  const rerun = useCallback((m?: Mode) => {
    if (m) setMode(m);
    setRunId((n) => n + 1);
  }, []);

  return (
    <Detail
      isLoading={!done && progress.phase !== "error"}
      navigationTitle={`${PHASE_LABEL[progress.phase]}${pct}${mode === "quick" ? " · Quick" : ""}`}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title={done || progress.phase === "error" ? "Run Again" : "Restart Test"}
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => rerun()}
          />
          <Action
            title="Copy Results"
            icon={Icon.Clipboard}
            shortcut={Keyboard.Shortcut.Common.Copy}
            onAction={async () => {
              await Clipboard.copy(summary(progress));
              await showToast({ title: "Copied results" });
            }}
          />
          <Action.Push
            title="Show History"
            icon={Icon.LineChart}
            shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
            target={<History />}
          />
          <Action
            title={mode === "quick" ? "Run Full Test" : "Run Quick Test"}
            icon={Icon.Bolt}
            shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            onAction={() => rerun(mode === "quick" ? "full" : "quick")}
          />
          <Action.OpenInBrowser title="Open Cloudflare Speed Test" url="https://speed.cloudflare.com" />
        </ActionPanel>
      }
    />
  );
}
