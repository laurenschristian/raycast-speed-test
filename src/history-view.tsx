import { Action, ActionPanel, Alert, confirmAlert, environment, Icon, List, LocalStorage } from "@raycast/api";
import { useEffect, useState } from "react";
import { fmtMbps, fmtMs, loadHistory, type Result, summary } from "./history";
import { bloatGrade, renderTrend, toDataUri } from "./render";

export default function History() {
  const [items, setItems] = useState<Result[]>();
  useEffect(() => {
    loadHistory().then(setItems);
  }, []);
  const theme = environment.appearance === "light" ? "light" : "dark";
  const avg = (k: "downloadMbps" | "uploadMbps" | "pingMs") => {
    const xs = (items ?? []).map((r) => r[k]).filter((v): v is number => v !== undefined);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
  };

  return (
    <List navigationTitle="Speed Test History" isLoading={!items} isShowingDetail={!!items?.length}>
      <List.EmptyView icon={Icon.LineChart} title="No runs yet" description="Run Test Internet Speed first." />
      {items?.map((r) => {
        const grade = bloatGrade(r.pingMs, r.loadedPingMs)?.grade;
        const md = `![](${toDataUri(renderTrend(items, theme, r.at))}?raycast-width=460)`;
        return (
          <List.Item
            key={r.at}
            icon={Icon.Gauge}
            title={`↓ ${fmtMbps(r.downloadMbps)}  ↑ ${fmtMbps(r.uploadMbps)}`}
            accessories={[{ date: new Date(r.at) }]}
            detail={
              <List.Item.Detail
                markdown={md}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Download" text={`${fmtMbps(r.downloadMbps)} Mbps`} />
                    <List.Item.Detail.Metadata.Label title="Upload" text={`${fmtMbps(r.uploadMbps)} Mbps`} />
                    <List.Item.Detail.Metadata.Label title="Ping" text={`${fmtMs(r.pingMs)} ms`} />
                    <List.Item.Detail.Metadata.Label title="Jitter" text={`${fmtMs(r.jitterMs)} ms`} />
                    {grade && <List.Item.Detail.Metadata.Label title="Bufferbloat" text={grade} />}
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label title="Provider" text={r.isp ?? "-"} />
                    <List.Item.Detail.Metadata.Label title="Server" text={r.colo ? `Cloudflare ${r.colo}` : "-"} />
                    <List.Item.Detail.Metadata.Label title="Connection" text={r.kind ?? "-"} />
                    <List.Item.Detail.Metadata.Label title="Time" text={new Date(r.at).toLocaleString()} />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="Average (all runs)"
                      text={`↓ ${fmtMbps(avg("downloadMbps"))}  ↑ ${fmtMbps(avg("uploadMbps"))} Mbps · ${fmtMs(avg("pingMs"))} ms`}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Result" content={summary(r)} />
                <Action
                  title="Clear History"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    const ok = await confirmAlert({
                      title: "Clear all speed test history?",
                      primaryAction: { title: "Clear", style: Alert.ActionStyle.Destructive },
                    });
                    if (!ok) return;
                    await LocalStorage.removeItem("history");
                    setItems([]);
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
