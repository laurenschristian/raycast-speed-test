import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export type LocalInfo = {
  interface?: string;
  kind?: string;
  localIp?: string;
  dns?: string;
  wifi?: { channel?: string; phy?: string; signal?: number; noise?: number; rate?: number; security?: string };
};

async function sh(cmd: string, args: string[]) {
  try {
    return (await run(cmd, args, { timeout: 10000 })).stdout;
  } catch {
    return "";
  }
}

export async function getLocalInfo(): Promise<LocalInfo> {
  const route = await sh("/sbin/route", ["-n", "get", "default"]);
  const iface = /interface:\s*(\S+)/.exec(route)?.[1];
  const info: LocalInfo = { interface: iface };
  info.localIp = os.networkInterfaces()[iface ?? ""]?.find((a) => a.family === "IPv4")?.address;

  const ports = await sh("/usr/sbin/networksetup", ["-listallhardwareports"]);
  const port = new RegExp(`Hardware Port: (.+)\\nDevice: ${iface}\\b`).exec(ports)?.[1];
  info.kind = port?.includes("Wi-Fi") ? "Wi-Fi" : iface?.startsWith("utun") ? "VPN" : port ? "Ethernet" : iface;

  const dns = await sh("/usr/sbin/scutil", ["--dns"]);
  info.dns = /nameserver\[0\]\s*:\s*(\S+)/.exec(dns)?.[1];

  if (info.kind === "Wi-Fi") {
    const raw = await sh("/usr/sbin/system_profiler", ["SPAirPortDataType", "-json"]);
    try {
      type Net = Record<string, string | number | undefined>;
      type Iface = { _name?: string; spairport_current_network_information?: Net };
      const ifaces = JSON.parse(raw).SPAirPortDataType[0].spairport_airport_interfaces as Iface[];
      const cur = ifaces.find((i) => i._name === iface)?.spairport_current_network_information;
      const [signal, noise] =
        String(cur?.spairport_signal_noise ?? "")
          .match(/-?\d+/g)
          ?.map(Number) ?? [];
      info.wifi = {
        channel: cur?.spairport_network_channel as string | undefined,
        phy: cur?.spairport_network_phymode as string | undefined,
        rate: cur?.spairport_network_rate as number | undefined,
        security: String(cur?.spairport_security_mode ?? "")
          .replace("spairport_security_mode_", "")
          .replace(/_/g, " ")
          .toUpperCase(),
        signal,
        noise,
      };
    } catch {
      // system_profiler output shape varies across macOS versions; Wi-Fi details are optional.
    }
  }
  return info;
}

export function signalQuality(dbm?: number) {
  if (dbm === undefined) return undefined;
  return dbm >= -55 ? "Excellent" : dbm >= -65 ? "Good" : dbm >= -72 ? "Fair" : "Weak";
}
