; Inno Setup script for OffloadMQ Agent v2
; Produces a single-exe installer containing both omq-gui.exe (GUI) and omq.exe (CLI).
;
; Build directly:
;   ISCC /DINSTALLER_VERSION=v0.3.260 scripts\windows-installer.iss
; Or via Taskfile (auto-detects version):
;   task installer:windows          (from agent_v2/)

#ifndef INSTALLER_VERSION
  #define INSTALLER_VERSION "0.0.0"
#endif
#define AppName      "OffloadMQ Agent"
#define AppPublisher "OffloadMQ"
#define AppVersion   INSTALLER_VERSION

; Paths are relative to this .iss file, which lives in agent_v2/scripts/
#define GuiBin "..\gui-manager\dist\omq-gui.exe"
#define CliBin "..\cli-manager\dist\omq.exe"
#define OutDir "..\installer-out"

[Setup]
AppId={{4B8C3D2E-1F6A-4E8B-9C2D-5F7E8D9C3B1A}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\omq
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir={#OutDir}
OutputBaseFilename=omq-setup-{#AppVersion}-windows
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\omq-gui.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: desktopicon; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"
Name: addtopath; Description: "Add install directory to &PATH (for omq CLI)"; GroupDescription: "Shell:"
Name: autostart; Description: "Start {#AppName} automatically at Windows &login"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#GuiBin}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#CliBin}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\omq-gui.exe"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\omq-gui.exe"; Tasks: desktopicon

[Registry]
; Autostart via HKCU Run key (matches upgrade script expectation: value name "OffloadAgent")
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OffloadAgent"; ValueData: """{app}\omq-gui.exe"""; Tasks: autostart; Flags: uninsdeletevalue

[Code]
// Kill running agent processes before files are extracted so the installer
// can overwrite locked binaries.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  OldPath: string;
  InstallDir: string;
begin
  if CurStep = ssInstall then
  begin
    Exec('taskkill', '/F /IM omq-gui.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('taskkill', '/F /IM omq.exe',     '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  if (CurStep = ssPostInstall) and IsTaskSelected('addtopath') then
  begin
    InstallDir := ExpandConstant('{app}');
    if not RegQueryStringValue(HKCU, 'Environment', 'Path', OldPath) then
      OldPath := '';
    if Pos(';' + Lowercase(InstallDir) + ';', Lowercase(';' + OldPath + ';')) = 0 then
      RegWriteStringValue(HKCU, 'Environment', 'Path', OldPath + ';' + InstallDir);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OldPath, Segment: string;
  P: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Segment := ';' + ExpandConstant('{app}');
    if RegQueryStringValue(HKCU, 'Environment', 'Path', OldPath) then
    begin
      P := Pos(Lowercase(Segment), Lowercase(OldPath));
      if P > 0 then
        RegWriteStringValue(HKCU, 'Environment', 'Path',
          Copy(OldPath, 1, P - 1) + Copy(OldPath, P + Length(Segment), MaxInt));
    end;
  end;
end;

[Run]
Filename: "{app}\omq-gui.exe"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM omq-gui.exe"; Flags: runhidden; RunOnceId: "KillGuiAgent"
Filename: "taskkill"; Parameters: "/F /IM omq.exe"; Flags: runhidden; RunOnceId: "KillCliAgent"
