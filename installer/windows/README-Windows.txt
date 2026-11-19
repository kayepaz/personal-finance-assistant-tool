PFAT - Personal Finance Assistant Tool (Windows)
===============================================

Opening PFAT
  Start menu > PFAT. It opens http://localhost:8787 in your browser, starting the server if it
  isn't already running. The first time, you choose a passphrase.

  PFAT runs quietly in the background (no window). Prices, triggers and reminders are only checked
  while it's running, so leave "Start PFAT when I sign in" on unless you prefer to start it yourself.

Stopping PFAT
  Start menu > Stop PFAT.

Your data
  Everything stays on this computer, in:
    %LOCALAPPDATA%\PFAT
  data.db holds what you enter; cache.db holds prices and can be rebuilt. pfat.log is the server's log.
  Use Settings > Backup in PFAT for encrypted backups. Uninstalling asks before deleting this folder.

Other devices on your network (phones, other computers)
  Turn this on by running the installer again and ticking "Allow phones and other computers on my
  home network to connect", or from a Command Prompt:
    "%LOCALAPPDATA%\Programs\PFAT\pfat.exe" config lan on
  then Stop PFAT and open it again. Other devices go to http://<this computer's address>:8787
  (find the address with "ipconfig", e.g. 192.168.1.20). The firewall rule the installer adds only
  allows private (home) networks.

  Over the network the connection is plain HTTP, so browsers on other devices treat it as not secure
  and won't install PFAT as an app or use it offline. The README on GitHub explains how to add HTTPS.

Changing the port
    "%LOCALAPPDATA%\Programs\PFAT\pfat.exe" config port 8800
  then Stop PFAT and open it again (the Start menu shortcut follows the setting).

"Windows protected your PC"
  The installer isn't code-signed yet, so SmartScreen may warn about it. Choose "More info" >
  "Run anyway" if the file came from the project's GitHub releases page. Each release lists a
  SHA-256 checksum you can compare with:
    certutil -hashfile PFAT-Setup-<version>.exe SHA256

Help and source: https://github.com/kayepaz/personal-finance-assistant-tool
