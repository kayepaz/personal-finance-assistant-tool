// Browser tests: start a throwaway PFAT server with an empty data folder and drive it with Chromium.
import { defineConfig } from "playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 8899;
const dataDir = mkdtempSync(join(tmpdir(), "pfat-e2e-"));

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  workers: 1, // one server, one shared set of data: tests run in order
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: "deno run --allow-net --allow-read --allow-write --allow-env ../server/main.ts",
    url: `http://127.0.0.1:${port}/api/status`,
    env: { PFAT_PORT: String(port), PFAT_DATA_DIR: dataDir, PFAT_SCHEDULER_MINUTES: "60" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
