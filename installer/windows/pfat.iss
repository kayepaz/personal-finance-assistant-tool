; PFAT Windows installer (Inno Setup 6). Built by .github/workflows/release.yml:
;   iscc /DAppVersion=0.5.0 installer\windows\pfat.iss
; Installs for the current user only (no admin rights), into %LOCALAPPDATA%\Programs\PFAT. Data lives in
; %LOCALAPPDATA%\PFAT and survives upgrades. Only the optional "other devices on my network" task asks for
; admin rights, to add a Windows Firewall rule.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef SourceExe
  #define SourceExe "..\..\dist\pfat.exe"
#endif
#define AppName "PFAT"
#define AppLongName "PFAT - Personal Finance Assistant Tool"
#define FirewallRule "PFAT (Personal Finance Assistant Tool)"

[Setup]
AppId={{6B0F3A52-4D1E-4C8B-9E7A-2F5C1D9B8A31}
AppName={#AppName}
AppVerName={#AppName} {#AppVersion}
AppVersion={#AppVersion}
AppPublisher=PFAT contributors
AppPublisherURL=https://github.com/kayepaz/personal-finance-assistant-tool
AppSupportURL=https://github.com/kayepaz/personal-finance-assistant-tool/issues
DefaultDirName={localappdata}\Programs\PFAT
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=PFAT-Setup-{#AppVersion}
SetupIconFile=pfat.ico
UninstallDisplayIcon={app}\pfat.exe
UninstallDisplayName={#AppLongName}
LicenseFile=..\..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no

[Tasks]
Name: "startup"; Description: "Start PFAT when I sign in (runs quietly in the background; prices and reminders need it running)"
Name: "lan"; Description: "Allow phones and other computers on my home network to connect (adds a firewall rule; asks for admin rights)"; Flags: unchecked
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "pfat.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "README-Windows.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{userprograms}\PFAT"; Filename: "{app}\pfat.exe"; Parameters: "--open"; IconFilename: "{app}\pfat.ico"; Comment: "Open PFAT in your browser (starts it if needed)"
Name: "{userprograms}\Stop PFAT"; Filename: "{sys}\taskkill.exe"; Parameters: "/im pfat.exe /f"; IconFilename: "{app}\pfat.ico"; Comment: "Stop the PFAT server"
Name: "{userdesktop}\PFAT"; Filename: "{app}\pfat.exe"; Parameters: "--open"; IconFilename: "{app}\pfat.ico"; Tasks: desktopicon
Name: "{userstartup}\PFAT"; Filename: "{app}\pfat.exe"; IconFilename: "{app}\pfat.ico"; Comment: "PFAT server"; Tasks: startup

[Registry]
; Remember that a firewall rule was added, so the uninstaller only asks for admin rights when it must.
Root: HKCU; Subkey: "Software\PFAT"; ValueType: dword; ValueName: "FirewallRule"; ValueData: 1; Tasks: lan; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\PFAT"; Flags: uninsdeletekeyifempty

[Run]
; Record the network choice in %LOCALAPPDATA%\PFAT\pfat.config.json (any port you've set is kept).
Filename: "{app}\pfat.exe"; Parameters: "config lan on"; Flags: runhidden waituntilterminated; Tasks: lan
Filename: "{app}\pfat.exe"; Parameters: "config lan off"; Flags: runhidden waituntilterminated; Tasks: not lan
; One admin prompt: replace any old rule with one for this program on private (home) networks only.
Filename: "{cmd}"; Parameters: "/c netsh advfirewall firewall delete rule name=""{#FirewallRule}"" >nul 2>&1 & netsh advfirewall firewall add rule name=""{#FirewallRule}"" dir=in action=allow program=""{app}\pfat.exe"" enable=yes profile=private"; Verb: "runas"; Flags: shellexec runhidden waituntilterminated; Tasks: lan; StatusMsg: "Allowing PFAT through Windows Firewall on private networks..."
Filename: "{app}\pfat.exe"; Parameters: "--open"; Description: "Open PFAT now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/im pfat.exe /f"; Flags: runhidden; RunOnceId: "StopPfat"

[Code]
procedure StopPfat();
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/im pfat.exe /f', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ Upgrading: stop the running copy first so pfat.exe can be replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopPfat();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    if RegValueExists(HKCU, 'Software\PFAT', 'FirewallRule') then
      ShellExec('runas', ExpandConstant('{sys}\netsh.exe'),
        'advfirewall firewall delete rule name="{#FirewallRule}"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\PFAT');
    if DirExists(DataDir) and not UninstallSilent() then
      if MsgBox('Also delete your PFAT data?' + #13#10 + #13#10 +
                'This removes your accounts, theses, trades and settings in ' + DataDir +
                ' and cannot be undone. Choose No to keep them for a later reinstall (or make a backup first).',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
