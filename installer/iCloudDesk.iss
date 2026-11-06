; iCloud Desk installer (Inno Setup 6).
;
; Built by scripts\build.ps1, which stages the core (icd.exe + _internal\) and the shell
; (iCloudDesk.exe) into build\stage and then runs:
;   ISCC.exe /DAppVersion=0.2.0 /DStageDir=..\build\stage /DOutputDir=..\dist installer\iCloudDesk.iss
;
; Per-user install (no UAC prompt): {localappdata}\Programs\iCloud Desk.

#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef StageDir
  #define StageDir "..\build\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

#define AppName "iCloud Desk"
#define AppExe "iCloudDesk.exe"
#define CoreExe "icd.exe"
#define AppPublisher "iCloud Desk"
#define AppUserModelId "iCloudDesk.App"
#define AppPathsKey "Software\Microsoft\Windows\CurrentVersion\App Paths"

[Setup]
AppId={{01D03A11-7AD0-4D50-9B37-EAE7A2EE8EF3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
DisableWelcomePage=yes
UsePreviousAppDir=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=iCloudDesk-Setup-{#AppVersion}
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
ChangesEnvironment=yes
CloseApplications=force
CloseApplicationsFilter=*.exe,*.dll,*.pyd
RestartApplications=no
ShowLanguageDialog=auto

[Languages]
Name: "chinesesimplified"; MessagesFile: "Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.CliGroup=命令行工具：
chinesesimplified.AddToPath=将 icd 命令添加到 PATH 环境变量（可在终端中直接运行 icd）
chinesesimplified.LaunchApp=启动 iCloud Desk
english.CliGroup=Command line:
english.AddToPath=Add the icd command to PATH (run icd from any terminal)
english.LaunchApp=Launch iCloud Desk

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "addtopath"; Description: "{cm:AddToPath}"; GroupDescription: "{cm:CliGroup}"

[InstallDelete]
; The PyInstaller payload changes between versions; never mix old and new modules.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#StageDir}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\{#CoreExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\_internal\*"; DestDir: "{app}\_internal"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; AppUserModelID: "{#AppUserModelId}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; AppUserModelID: "{#AppUserModelId}"; Tasks: desktopicon

[Registry]
; App Paths so that Win+R "iCloudDesk" / "icd" work even without PATH.
Root: HKCU; Subkey: "{#AppPathsKey}\{#AppExe}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "{#AppPathsKey}\{#AppExe}"; ValueType: string; ValueName: "Path"; ValueData: "{app}"
Root: HKCU; Subkey: "{#AppPathsKey}\{#CoreExe}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#CoreExe}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "{#AppPathsKey}\{#CoreExe}"; ValueType: string; ValueName: "Path"; ValueData: "{app}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchApp}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
const
  EnvKey = 'Environment';

function NormalizeDir(const S: String): String;
begin
  Result := Lowercase(RemoveBackslashUnlessRoot(Trim(RemoveQuotes(Trim(S)))));
end;

{ Returns the ';'-separated PATH value minus every entry equal to Dir (case-insensitive).
  Other entries, including empty ones, are kept verbatim. }
function PathWithout(const Paths, Dir: String; var Found: Boolean): String;
var
  Rest, Item: String;
  P: Integer;
  First, Last: Boolean;
begin
  Result := '';
  Found := False;
  Rest := Paths;
  First := True;
  Last := False;
  while not Last do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Item := Rest;
      Last := True;
    end
    else
    begin
      Item := Copy(Rest, 1, P - 1);
      Delete(Rest, 1, P);
    end;
    if (Trim(Item) <> '') and (NormalizeDir(Item) = NormalizeDir(Dir)) then
    begin
      Found := True;
      { Keep the separator of a removed trailing entry so "x;" + "Dir" round-trips to "x;". }
      if Last and not First then
        Result := Result + ';';
    end
    else
    begin
      if not First then
        Result := Result + ';';
      Result := Result + Item;
      First := False;
    end;
  end;
end;

procedure AddToUserPath(const Dir: String);
var
  Paths, Cleaned: String;
  Found: Boolean;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    Paths := '';
  Cleaned := PathWithout(Paths, Dir, Found);
  if Found then
    Exit;
  if (Paths <> '') and (Paths[Length(Paths)] <> ';') then
    Paths := Paths + ';';
  Paths := Paths + Dir;
  if RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths) then
    Log('Added to user PATH: ' + Dir)
  else
    Log('Failed to update user PATH');
end;

procedure RemoveFromUserPath(const Dir: String);
var
  Paths, Cleaned: String;
  Found: Boolean;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    Exit;
  Cleaned := PathWithout(Paths, Dir, Found);
  if not Found then
    Exit;
  if Cleaned = '' then
    RegDeleteValue(HKCU, EnvKey, 'Path')
  else
    RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Cleaned);
  Log('Removed from user PATH: ' + Dir);
end;

{ Closes the shell window and stops the background daemons of the installation in Dir. }
procedure StopRunningApp(const Dir: String);
var
  Code: Integer;
  Ps: String;
begin
  if FileExists(Dir + '\{#AppExe}') then
    { "--quit" asks the running window to close and waits until it has exited. }
    Exec(Dir + '\{#AppExe}', '--quit', Dir, SW_HIDE, ewWaitUntilTerminated, Code);
  if FileExists(Dir + '\{#CoreExe}') then
  begin
    Exec(Dir + '\{#CoreExe}', 'daemon stop', Dir, SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(Dir + '\{#CoreExe}', 'daemon stop --demo', Dir, SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  { Last resort: anything still running from the install directory (e.g. a stuck CLI call). }
  Ps := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if FileExists(Ps) then
    Exec(Ps, '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
      '$d = ''' + AddBackslash(Dir) + '''; ' +
      'Get-Process -Name icd,iCloudDesk -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.Path -and $_.Path.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) } | ' +
      'ForEach-Object { try { $_.Kill(); $_.WaitForExit(5000) | Out-Null } catch {} }"',
      Dir, SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(300);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopRunningApp(RemoveBackslashUnlessRoot(ExpandConstant('{app}')));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('addtopath') then
      AddToUserPath(ExpandConstant('{app}'))
    else
      RemoveFromUserPath(ExpandConstant('{app}'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  case CurUninstallStep of
    usUninstall:
      StopRunningApp(RemoveBackslashUnlessRoot(ExpandConstant('{app}')));
    usPostUninstall:
      RemoveFromUserPath(ExpandConstant('{app}'));
  end;
end;
