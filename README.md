# PFAT — Personal Finance Assistant Tool

Track **why** you bought each self-directed investment and **when** you plan to sell it — plus an approximate
balance sheet of everything you own and owe. Self-hosted. Your data never leaves your server without your
explicit permission.

PFAT is not a ledger: balances are approximate, and taxes, fees and jurisdiction rules are noted, never
calculated.

**Why the local data philosophy? Isn't it easier to use cloud-based services?** See
[Why local data?](VISION.md#why-local-data) in the vision.

## Status

Pre-alpha, v0.4.0. What changed is in the [CHANGELOG](CHANGELOG.md); how it works is in
[docs/SPEC.md](docs/SPEC.md) and [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

## Run it

### On Windows (installer)

Download `PFAT-Setup-<version>.exe` from the
[releases page](https://github.com/kayepaz/personal-finance-assistant-tool/releases) and run it. It installs
for your Windows account only (no admin rights) and adds **PFAT** and **Stop PFAT** to the Start menu.
**PFAT** opens http://localhost:8787 in your browser, starting the server in the background if it isn't
running. The installer offers to:

- **start PFAT when you sign in**, so prices, triggers and reminders keep being checked (on by default);
- **allow phones and other computers on your home network to connect**. This listens on all network interfaces
  and adds a Windows Firewall rule for private networks; it's the only step that asks for admin rights.

Data lives in `%LOCALAPPDATA%\PFAT` (with `pfat.log`, the server log) and is kept when you upgrade; the
uninstaller asks before deleting it. To change settings later, run `pfat.exe config lan on|off` or
`pfat.exe config port <number>` from `%LOCALAPPDATA%\Programs\PFAT`, then Stop PFAT and open it again. The
installer isn't code-signed yet, so SmartScreen may say "Windows protected your PC": choose **More info → Run
anyway** after checking the file against `SHA256SUMS.txt` on the release.

### From source (any system)

Requires [Deno](https://deno.com) 2.2 or newer. There are no other dependencies and no build step.

```sh
deno task start
```

Open http://localhost:8787 and set your passphrase and base currency. Data is stored in `./data/` (`data.db` =
your data, `cache.db` = market data that can be rebuilt).

| Environment variable     | Default     | Meaning                                                                     |
| ------------------------ | ----------- | --------------------------------------------------------------------------- |
| `PFAT_PORT`              | `8787`      | HTTP port                                                                   |
| `PFAT_HOST`              | `127.0.0.1` | Bind address (use `0.0.0.0` to reach it from other devices on your network) |
| `PFAT_DATA_DIR`          | `./data`    | Where the two SQLite files live                                             |
| `PFAT_SCHEDULER_MINUTES` | `60`        | How often background jobs run                                               |

The same settings can live in `pfat.config.json` in the data folder (`{"lan": true, "port": 8800}`; edit it
with `deno task start config lan on`). Environment variables win over the file, and `--lan`, `--no-lan`,
`--port <n>` and `--open` (open a browser) win over both. Starting PFAT when it's already running just opens
the browser (with `--open`) and exits.

Market-data keys (Alpha Vantage, Finnhub) are entered in Settings, and each provider is only contacted after
you consent to it.

## Use it from other devices

### On your home network (plain HTTP)

1. Start PFAT listening on all interfaces:

   ```sh
   PFAT_HOST=0.0.0.0 deno task start
   ```

2. Find the machine's LAN address with `ip -4 addr show | grep inet` (e.g. `192.168.1.50`).
3. If a firewall is on (`sudo ufw status`), allow PFAT from your LAN only:

   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp
   ```

4. On another device, open `http://192.168.1.50:8787` and sign in. Each device appears under Settings →
   Signed-in devices, where you can sign it out.

Plain HTTP sends your passphrase and session tokens unencrypted, so only do this on a network you trust.
Browsers also only offer "install app" and offline caching over HTTPS (or on `localhost`). Use one of the
options below for HTTPS.

### HTTPS with Tailscale (easiest)

[Tailscale](https://tailscale.com) puts your devices on a private network and can issue real certificates.

1. Install Tailscale on the PFAT machine and on each device you'll use, and sign in to the same account.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**.
3. Keep PFAT on its default `127.0.0.1` and publish it to your tailnet:

   ```sh
   tailscale serve --bg 8787
   ```

4. Open the `https://<machine-name>.<your-tailnet>.ts.net` address it prints, from any of your devices.

Only devices signed in to your tailnet can reach it. Stop with `tailscale serve --https=443 off`.

### HTTPS with Caddy (LAN only, no third party)

[Caddy](https://caddyserver.com) can act as a local certificate authority.

1. Keep PFAT on `127.0.0.1` and install Caddy (`sudo pacman -S caddy` on Arch/Omarchy).
2. Create a `Caddyfile`, using the machine's LAN address:

   ```
   https://192.168.1.50 {
     tls internal
     reverse_proxy 127.0.0.1:8787
   }
   ```

3. Run `caddy run` in that folder (or install it as a service), and allow port 443 through the firewall from
   your LAN.
4. Each device must trust Caddy's local root certificate once: copy `root.crt` from Caddy's data folder
   (`~/.local/share/caddy/pki/authorities/local/` when run as your user) to the device and install it as a
   trusted certificate. Then open `https://192.168.1.50`.

## Develop

To build the Windows installer, push a version tag (it must match `deno.json`): the
[Windows installer workflow](.github/workflows/release.yml) builds `pfat.exe` with `deno compile`, smoke-tests
it, builds `PFAT-Setup-<version>.exe` with [Inno Setup](https://jrsoftware.org/isinfo.php)
(`installer/windows/pfat.iss`), test-installs and uninstalls it, and attaches it with checksums to the
release. Run the workflow by hand from the Actions tab to get a test build without a release. Locally,
`deno task
compile:windows` builds just `dist/pfat.exe`.

```sh
deno task dev     # restart on change
deno task test    # run the test suite
cd e2e && npm install && npx playwright install chromium && npx playwright test   # browser tests (dev only)
deno task check   # type-check server and client
deno task lint
deno task fmt
```

## Project

- [VISION.md](VISION.md) — what PFAT is and isn't
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to help
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CHANGELOG.md](CHANGELOG.md) — semantic versioning

Governance: BDFL ([@kayepaz](https://github.com/kayepaz)). License:
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
