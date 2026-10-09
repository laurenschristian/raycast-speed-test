import { Clipboard, environment, Icon, LaunchType, launchCommand, MenuBarExtra, open, showHUD } from "@raycast/api";
import { useEffect, useState } from "react";
import { runSpeedTest } from "./engine";
import { fmtMbps, fmtMs, loadHistory, type Result, saveResult, summary } from "./history";
import { getLocalInfo } from "./network";

export default function MenuBar() {
  const [history, setHistory] = useState<Result[]>();
  const [running, setRunning] = useState(environment.launchType === LaunchType.Background);

  useEffect(() => {
    loadHistory().then(setHistory);
  }, []);

  useEffect(() => {
    if (!running) return;
    // Background interval runs use quick mode so the menu bar stays responsive.
    runSpeedTest(new AbortController().signal, () => {}, "quick")
      .then(async (p) => setHistory(await saveResult(p, await getLocalInfo())))
      .catch(() => {})
      .finally(() => setRunning(false));
  }, [running]);

  const last = history?.[0];
  const title = running ? "Testing…" : last ? `↓${fmtMbps(last.downloadMbps)} ↑${fmtMbps(last.uploadMbps)}` : undefined;

  return (
    <MenuBarExtra icon={Icon.Gauge} title={title} isLoading={!history || running} tooltip="Speed Test">
      {last && (
        <MenuBarExtra.Section
          title={`Last run · ${new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        >
          <MenuBarExtra.Item
            title={`Download  ${fmtMbps(last.downloadMbps)} Mbps`}
            onAction={() => Clipboard.copy(summary(last))}
          />
          <MenuBarExtra.Item
            title={`Upload  ${fmtMbps(last.uploadMbps)} Mbps`}
            onAction={() => Clipboard.copy(summary(last))}
          />
          <MenuBarExtra.Item title={`Ping  ${fmtMs(last.pingMs)} ms · Jitter ${fmtMs(last.jitterMs)} ms`} />
          {last.isp && <MenuBarExtra.Item title={[last.isp, last.kind].filter(Boolean).join(" · ")} />}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title={running ? "Testing…" : "Run Quick Test"}
          icon={Icon.Bolt}
          onAction={() => {
            if (!running) setRunning(true);
          }}
        />
        <MenuBarExtra.Item
          title="Open Speed Test"
          icon={Icon.Gauge}
          onAction={() => launchCommand({ name: "index", type: LaunchType.UserInitiated })}
        />
        <MenuBarExtra.Item
          title="Show History"
          icon={Icon.LineChart}
          onAction={() => launchCommand({ name: "speed-history", type: LaunchType.UserInitiated })}
        />
      </MenuBarExtra.Section>
      {history && history.length > 1 && (
        <MenuBarExtra.Section title="Recent">
          {history.slice(1, 6).map((r) => (
            <MenuBarExtra.Item
              key={r.at}
              title={`↓${fmtMbps(r.downloadMbps)} ↑${fmtMbps(r.uploadMbps)} · ${fmtMs(r.pingMs)} ms`}
              subtitle={new Date(r.at).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
              onAction={async () => {
                await Clipboard.copy(summary(r));
                await showHUD("Copied result");
              }}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Cloudflare Speed Test"
          icon={Icon.Globe}
          onAction={() => open("https://speed.cloudflare.com")}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
