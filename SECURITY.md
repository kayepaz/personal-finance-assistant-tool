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
  user passphrase.
- Outbound requests (market data, notification channels) require recorded consent and never include holdings,
  quantities or balances.
- When serving other devices, run behind HTTPS.
