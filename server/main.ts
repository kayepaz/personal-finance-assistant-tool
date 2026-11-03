/** PFAT server entry point. */
import { openAll } from "./db/db.ts";
import { createApp } from "./app.ts";
import { isSetUp } from "./services/auth.ts";
import { runJobs } from "./services/engine.ts";

const port = Number(Deno.env.get("PFAT_PORT") ?? 8787);
const hostname = Deno.env.get("PFAT_HOST") ?? "127.0.0.1";
const dataDir = Deno.env.get("PFAT_DATA_DIR") ?? "./data";
const everyMinutes = Math.max(5, Number(Deno.env.get("PFAT_SCHEDULER_MINUTES") ?? 60));

const dbs = openAll(dataDir);
const handler = createApp({ dbs });

let running = false;
async function tick() {
  if (running || !isSetUp(dbs.data)) return;
  running = true;
  try {
    const r = await runJobs(dbs);
    const p = r.prices;
    console.log(
      `[jobs] prices +${p.updated.length} deferred ${p.deferred.length} failed ${p.failed.length}; ` +
        `triggers ${r.triggers_fired}, claim reviews ${r.claim_reviews}, balance reminders ${r.balance_reminders}`,
    );
  } catch (err) {
    console.error("[jobs] failed:", err);
  } finally {
    running = false;
  }
}

setTimeout(tick, 5_000);
setInterval(tick, everyMinutes * 60_000);

Deno.serve({ port, hostname, onListen: ({ hostname, port }) => {
  console.log(`PFAT listening on http://${hostname}:${port}  (data: ${dataDir}, jobs every ${everyMinutes} min)`);
} }, handler);
