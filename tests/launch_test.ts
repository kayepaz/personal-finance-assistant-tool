/** Start-up settings: data folder, config file, LAN switch, and `pfat config`. */
import assert from "node:assert/strict";
import { defaultDataDir, openCommand, resolveLaunch, updateFileConfig } from "../server/launch.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
const noFile = () => null;

Deno.test("defaults: localhost only, port 8787, ./data (or %LOCALAPPDATA%\\PFAT on Windows)", () => {
  const l = resolveLaunch([], env({}), "linux", noFile);
  assert.deepEqual([l.command, l.hostname, l.port, l.lan, l.dataDir, l.openBrowser], [
    "serve",
    "127.0.0.1",
    8787,
    false,
    "./data",
    false,
  ]);
  const w = resolveLaunch(
    ["--open"],
    env({ LOCALAPPDATA: "C:\\Users\\kaye\\AppData\\Local" }),
    "windows",
    noFile,
  );
  assert.equal(w.dataDir, "C:\\Users\\kaye\\AppData\\Local\\PFAT");
  assert.equal(w.configPath, "C:\\Users\\kaye\\AppData\\Local\\PFAT\\pfat.config.json");
  assert.equal(w.openBrowser, true);
  assert.equal(defaultDataDir("windows", env({})), "./data", "no profile folder: fall back");
});

Deno.test("pfat.config.json turns on LAN access and sets the port; env and flags win", () => {
  const file = (text: string) => (path: string) => (path.endsWith("pfat.config.json") ? text : null);
  const lan = resolveLaunch([], env({}), "linux", file('{"lan": true, "port": 9000}'));
  assert.deepEqual([lan.hostname, lan.port, lan.lan], ["0.0.0.0", 9000, true]);
  const envWins = resolveLaunch(
    [],
    env({ PFAT_PORT: "7000", PFAT_HOST: "192.168.1.5" }),
    "linux",
    file('{"lan": true}'),
  );
  assert.deepEqual([envWins.hostname, envWins.port, envWins.lan], ["192.168.1.5", 7000, true]);
  assert.equal(resolveLaunch(["--no-lan"], env({}), "linux", file('{"lan": true}')).hostname, "127.0.0.1");
  assert.equal(resolveLaunch(["--lan"], env({}), "linux", noFile).hostname, "0.0.0.0");
  const junk = resolveLaunch([], env({}), "linux", file("{not json"));
  assert.deepEqual([junk.hostname, junk.port], ["127.0.0.1", 8787], "a broken file is ignored");
});

Deno.test("pfat config edits the settings file", () => {
  assert.deepEqual(updateFileConfig({}, ["lan", "on"]), { lan: true });
  assert.deepEqual(updateFileConfig({ lan: true }, ["port", "9001"]), { lan: true, port: 9001 });
  assert.throws(() => updateFileConfig({}, ["lan", "maybe"]), /lan on\|off/);
  assert.throws(() => updateFileConfig({}, ["port", "70000"]), /1-65535/);
  assert.throws(() => updateFileConfig({}, ["colour", "blue"]), /Unknown setting/);
  const l = resolveLaunch(["config", "lan", "off"], env({}), "linux", noFile);
  assert.deepEqual([l.command, l.configArgs], ["config", ["lan", "off"]]);
});

Deno.test("opening the browser uses each system's own command", () => {
  assert.deepEqual(openCommand("windows", "http://localhost:8787/"), [
    "rundll32",
    ["url.dll,FileProtocolHandler", "http://localhost:8787/"],
  ]);
  assert.equal(openCommand("darwin", "u")[0], "open");
  assert.equal(openCommand("linux", "u")[0], "xdg-open");
});
