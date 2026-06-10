; SnagTrack installer — Made by Karl Krusel (@karlkrusel)
; Compile with: "ISCC.exe" installer.iss

#define AppName "SnagTrack"
#define AppVersion "2.0.0"
#define AppPublisher "Karl Krusel (@karlkrusel)"
#define AppURL "https://www.instagram.com/karlkrusel/"
#define SrcDir "C:\Users\Karl\Downloads\Claude\SnagTrack"
#define DistDir "C:\Users\Karl\Downloads\Claude\SnagTrack\build\SnagTrack"

[Setup]
AppId={{B7A4F2C1-8E3D-4A9F-9C2B-5A1B2C3D4E5F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={localappdata}\SnagTrack
DefaultGroupName=SnagTrack
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir={#SrcDir}\dist
OutputBaseFilename=SnagTrack-Setup
SetupIconFile={#SrcDir}\favicon.ico
UninstallDisplayIcon={app}\favicon.ico
LicenseFile={#SrcDir}\LICENSE.txt
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\SnagTrack"; Filename: "{app}\SnagTrack.bat"; WorkingDir: "{app}"; IconFilename: "{app}\favicon.ico"
Name: "{group}\Uninstall SnagTrack"; Filename: "{uninstallexe}"
Name: "{userdesktop}\SnagTrack"; Filename: "{app}\SnagTrack.bat"; WorkingDir: "{app}"; IconFilename: "{app}\favicon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
Filename: "{app}\SnagTrack.bat"; Description: "Launch SnagTrack now"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove user-generated data on uninstall (logs + the persistent browser profile)
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\browser-profile"
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\session.json"
