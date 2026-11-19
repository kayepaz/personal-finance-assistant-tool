/**
 * How the server starts: where the data lives, which port and address it listens on, and the small
 * `pfat.config.json` the Windows installer writes. Precedence: command-line flags, then environment
 * variables, then the config file, then defaults.
 *
 *   pfat                      start the server
 *   pfat --open               start it (or find the copy already running) and open it in the browser
 *   pfat config               show the settings file
 *   pfat config lan on|off    allow other devices on the network (listens on 0.0.0.0 instead of 127.0.0.1)
 *   pfat config port 8787     change the port
 *   pfat --version
 */

export interface FileConfig {
  port?: number;
  /** Listen on every network interface so phones and other computers on the LAN can connect. */
  lan?: boolean;
}

export interface LaunchConfig {
  command: "serve" | "config" | "version";
  configArgs: string[];
  port: number;
  hostname: string;
  lan: boolean;
  dataDir: string;
  configPath: string;
  everyMinutes: number;
  openBrowser: boolean;
}

export const DEFAULT_PORT = 8787;
export const CONFIG_FILE = "pfat.config.json";

interface Env {
  get(key: string): string | undefined;
}

/** Windows keeps data in %LOCALAPPDATA%\PFAT (not next to the program); elsewhere ./data, as before. */
export function defaultDataDir(os: string, env: Env): string {
  if (os === "windows") {
    const base = env.get("LOCALAPPDATA") ??
      (env.get("USERPROFILE") ? `${env.get("USERPROFILE")}\\AppData\\Local` : "");
    if (base) return `${base}\\PFAT`;
  }
  return "./data";
}

export function joinPath(dir: string, file: string, os: string): string {
  const sep = os === "windows" ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + file : dir + sep + file;
}

export function parseFileConfig(text: string | null): FileConfig {
  if (!text) return {};
  try {
    const raw = JSON.parse(text);
    const out: FileConfig = {};
    if (Number.isInteger(raw?.port) && raw.port > 0 && raw.port < 65536) out.port = raw.port;
    if (typeof raw?.lan === "boolean") out.lan = raw.lan;
    return out;
  } catch {
    return {};
  }
}

export function resolveLaunch(
  args: string[],
  env: Env,
  os: string,
  readText: (path: string) => string | null,
): LaunchConfig {
  const command = args[0] === "config" ? "config" : args.includes("--version") ? "version" : "serve";
  const dataDir = env.get("PFAT_DATA_DIR") ?? defaultDataDir(os, env);
  const configPath = joinPath(dataDir, CONFIG_FILE, os);
  const file = parseFileConfig(readText(configPath));
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const portText = flag("--port") ?? env.get("PFAT_PORT");
  const port = portText ? Number(portText) : file.port ?? DEFAULT_PORT;
  const lan = args.includes("--lan") || (!args.includes("--no-lan") && (file.lan ?? false));
  const hostname = env.get("PFAT_HOST") ?? (lan ? "0.0.0.0" : "127.0.0.1");
  return {
    command,
    configArgs: command === "config" ? args.slice(1) : [],
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    hostname,
    lan: hostname !== "127.0.0.1" && hostname !== "localhost",
    dataDir,
    configPath,
    everyMinutes: Math.max(5, Number(env.get("PFAT_SCHEDULER_MINUTES") ?? 60)),
    openBrowser: args.includes("--open"),
  };
}

/** Apply `pfat config <key> <value>`; returns the new file contents, or throws a message for the user. */
export function updateFileConfig(current: FileConfig, args: string[]): FileConfig {
  const [key, value] = args;
  if (!key) return current;
  if (key === "lan") {
    if (!["on", "off", "true", "false"].includes(value ?? "")) throw new Error("Use: pfat config lan on|off");
    return { ...current, lan: value === "on" || value === "true" };
  }
  if (key === "port") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Use: pfat config port <1-65535>");
    return { ...current, port: n };
  }
  throw new Error(`Unknown setting '${key}'. Settings: lan, port`);
}

/** The address to open in a browser on this machine. */
export const localUrl = (port: number) => `http://localhost:${port}/`;

/** The command that opens a URL in the default browser. */
export function openCommand(os: string, url: string): [string, string[]] {
  if (os === "windows") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (os === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}
