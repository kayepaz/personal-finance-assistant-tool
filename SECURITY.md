# Security

PFAT stores personal financial data. Please report vulnerabilities privately.

## Reporting

Use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the Security tab of this
repository). Do not open a public issue. Expect an acknowledgement within 7 days.

## Supported versions

Only the latest release receives security fixes while PFAT is pre-1.0.

## Security model (summary)

- One user per instance. Access requires a passphrase (stored as a salted PBKDF2-SHA256 hash).
- Each device holds a random session token; the server stores only its SHA-256 hash. Sessions can be revoked.
- Data at rest is plain SQLite on the host; protect the host and its disk. Backups are always encrypted with a
  user passphrase (PBKDF2-SHA256 → AES-256-GCM, authenticated header). Restore keeps an unencrypted
  `pre-restore-*` copy next to the live databases; delete it once you're happy with the restore.
- The communication log (Settings) records every outbound call so you can audit exactly what left the server.
  Secrets in URLs and headers are masked; response bodies are stored as received (in `cache.db`).
- Alert channels send only what their consent text says; webhook payloads can be verified with the
  `X-PFAT-Signature` HMAC header.
- Outbound requests (market data, notification channels) require recorded consent and never include holdings,
  quantities or balances.
- When serving other devices, run behind HTTPS.
