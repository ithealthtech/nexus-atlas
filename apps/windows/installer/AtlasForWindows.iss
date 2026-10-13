; Atlas for Windows setup: installs for the person running it, with no administrator rights.
; Built by ..\build-installer.ps1, which passes the version and the folder of published files.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\app"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif
#define AppName "Atlas for Windows"
#define AppExe "AtlasForWindows.exe"
; Never change this: it is how Windows recognises a newer setup as an upgrade of the same app.
#define AppGuid "8C1F4E0A-5B7D-4E55-9A3C-2D6F0B1E7A94"
; The value the app itself writes for "Start with Windows" (StartupRegistration.cs).
#define RunValue "Atlas for Windows"

[Setup]
AppId={{{#AppGuid}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=MSP Atlas
VersionInfoVersion={#AppVersion}.0
DefaultDirName={localappdata}\Programs\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=AtlasForWindowsSetup
SetupIconFile=..\src\Atlas.Windows\Assets\Tray.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The running copy is closed by the code below, which asks it to quit cleanly first.
CloseApplications=no

[Tasks]
; Offered on a first install only. Afterwards the app's own "Start with Windows" setting decides, and an upgrade
; leaves it alone.
Name: "startup"; Description: "Start {#AppName} when I sign in to Windows"; Check: FreshInstall

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#RunValue}"; ValueData: """{app}\{#AppExe}"" --startup"; Tasks: startup; Check: FreshInstall

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The Atlas address, preferences, and the encrypted session token. An upgrade keeps them; uninstalling removes them.
Type: filesandordirs; Name: "{localappdata}\{#AppName}"

[Code]
const
  RunningMutex = 'AtlasForWindows.Running';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1';

var
  WasInstalled: Boolean;

function InitializeSetup(): Boolean;
begin
  WasInstalled := RegKeyExists(HKEY_CURRENT_USER, UninstallKey);
  Result := True;
end;

function FreshInstall(): Boolean;
begin
  Result := not WasInstalled;
end;

{ The app holds a named mutex while it runs. Ask it to quit, which clears a copied password from the clipboard and
  removes its tray icon; end it only if it doesn't. }
procedure CloseRunningApp();
var
  Exe: String;
  ResultCode, Waited: Integer;
begin
  if not CheckForMutexes(RunningMutex) then
    Exit;
  Exe := ExpandConstant('{app}\{#AppExe}');
  if FileExists(Exe) and Exec(Exe, '--quit', '', SW_HIDE, ewNoWait, ResultCode) then
  begin
    Waited := 0;
    while CheckForMutexes(RunningMutex) and (Waited < 15000) do
    begin
      Sleep(250);
      Waited := Waited + 250;
    end;
  end;
  if CheckForMutexes(RunningMutex) then
  begin
    Log('Atlas for Windows did not close when asked; ending it.');
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end
  else
    Log('Atlas for Windows closed when asked.');
  { Let the process finish exiting, so its files can be replaced. }
  Sleep(1500);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  CloseRunningApp();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  CloseRunningApp();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { Whether setup or the app turned "Start with Windows" on, it goes with the app. }
  if CurUninstallStep = usUninstall then
    RegDeleteValue(HKEY_CURRENT_USER, RunKey, '{#RunValue}');
end;
