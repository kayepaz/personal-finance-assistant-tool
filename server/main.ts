/** PFAT server entry point. See launch.ts for flags, environment variables and pfat.config.json. */
import config from "../deno.json" with { type: "json" };
import { openAll } from "./db/db.ts";
import { createApp } from "./app.ts";
import { isSetUp } from "./services/auth.ts";
import { runJobs } from "./services/engine.ts";
import { loggedFetch } from "./services/netlog.ts";
import { localUrl, openCommand, parseFileConfig, resolveLaunch, updateFileConfig } from "./launch.ts";

const os = Deno.build.os;
const readText = (path: string) => {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
};
const launch = resolveLaunch(Deno.args, Deno.env, os, readText);

if (launch.command === "version") {
  console.log(`PFAT v${config.version}`);
  Deno.exit(0);
}

if (launch.command === "config") {
  const current = parseFileConfig(readText(launch.configPath));
  try {
    const next = updateFileConfig(current, launch.configArgs);
    if (launch.configArgs.length) {
      Deno.mkdirSync(launch.dataDir, { recursive: true });
      Deno.writeTextFileSync(launch.configPath, JSON.stringify(next, null, 2) + "\n");
    }
    console.log(`${launch.configPath}\n${JSON.stringify(next, null, 2)}`);
    if (launch.configArgs.length) console.log("Restart PFAT for the change to take effect.");
    Deno.exit(0);
  } catch (err) {
    console.error((err as Error).message);
    Deno.exit(2);
  }
}

// Started from a shortcut with no console window (the Windows build): keep a log beside the data instead.
if (os === "windows" && !Deno.stdout.isTerminal()) {
  Deno.mkdirSync(launch.dataDir, { recursive: true });
  const logPath = `${launch.dataDir}\\pfat.log`;
  try {
    if (Deno.statSync(logPath).size > 1_000_000) Deno.removeSync(logPath);
  } catch { /* no log yet */ }
  const write = (level: string, parts: unknown[]) => {
    const line = `${new Date().toISOString()} ${level} ${
      parts.map((
        p,
      ) => (p instanceof Error ? p.stack ?? p.message : typeof p === "string" ? p : JSON.stringify(p)))
        .join(" ")
    }\n`;
    try {
      Deno.writeTextFileSync(logPath, line, { append: true });
    } catch { /* nowhere left to report it */ }
  };
  console.log = (...p: unknown[]) => write("INFO", p);
  console.error = (...p: unknown[]) => write("ERROR", p);
}

function openBrowser(url: string) {
  const [cmd, args] = openCommand(os, url);
  try {
    new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).spawn();
  } catch (err) {
    console.error(`Couldn't open a browser (${(err as Error).message}); go to ${url}`);
  }
}

// Already running (e.g. started at sign-in)? Then the shortcut just opens it.
async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return typeof body?.version === "string";
  } catch {
    return false;
  }
}

if (await alreadyRunning(launch.port)) {
  console.log(`PFAT is already running on port ${launch.port}.`);
  if (launch.openBrowser) openBrowser(localUrl(launch.port));
  Deno.exit(0);
}

const dbs = openAll(launch.dataDir);
const handler = createApp({ dbs });
const outbound = loggedFetch(() => dbs.cache);

let running = false;
async function tick() {
  if (running || !isSetUp(dbs.data)) return;
  running = true;
  try {
    const r = await runJobs(dbs, outbound);
    const p = r.prices;
    console.log(
      `[jobs] prices +${p.updated.length} deferred ${p.deferred.length} failed ${p.failed.length}; ` +
        `triggers ${r.triggers_fired}, claim reviews ${r.claim_reviews}, balance reminders ${r.balance_reminders}; ` +
        `alerts sent ${r.delivered.sent} failed ${r.delivered.failed}`,
    );
  } catch (err) {
    console.error("[jobs] failed:", err);
  } finally {
    running = false;
  }
}

/** This machine's LAN addresses, to show where other devices can connect. */
function lanAddresses(): string[] {
  try {
    return Deno.networkInterfaces()
      .filter((i) =>
        i.family === "IPv4" && !i.address.startsWith("127.") && !i.address.startsWith("169.254.")
      )
      .map((i) => i.address);
  } catch {
    return []; // needs --allow-sys=networkInterfaces
  }
}

try {
  Deno.serve({
    port: launch.port,
    hostname: launch.hostname,
    onListen: ({ hostname, port }) => {
      console.log(
        `PFAT v${config.version} listening on http://${hostname}:${port}  (data: ${launch.dataDir}, jobs every ${launch.everyMinutes} min)`,
      );
      if (launch.lan) {
        const addrs = lanAddresses();
        if (addrs.length) {
          console.log(`On your network: ${addrs.map((a) => `http://${a}:${port}/`).join("  ")}`);
        }
      }
      if (launch.openBrowser) openBrowser(localUrl(port));
    },
  }, handler);
} catch (err) {
  console.error(
    err instanceof Deno.errors.AddrInUse
      ? `Port ${launch.port} is in use by another program. Choose another with: pfat config port <number>`
      : err,
  );
  Deno.exit(1);
}

setTimeout(tick, 5_000);
setInterval(tick, launch.everyMinutes * 60_000);
