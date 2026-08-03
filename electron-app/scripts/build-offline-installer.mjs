import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Автономный установщик можно собрать только в Windows");
}

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  await fs.readFile(path.join(desktopDir, "package.json"), "utf8"),
);
const releaseDir = path.join(desktopDir, "release");
const unpackedDir = path.join(releaseDir, "win-unpacked");
// IExpress does not reliably handle non-ASCII source and target paths.
const stagingDir = path.join(os.tmpdir(), "schedule-automator-offline-installer");
const archivePath = path.join(stagingDir, "schedule-app.7z");
const installerPath = path.join(
  releaseDir,
  `Schedule-Automator-${packageJson.version}-Offline-Setup.exe`,
);
const stagedInstallerPath = path.join(
  stagingDir,
  `Schedule-Automator-${packageJson.version}-Offline-Setup.exe`,
);
const sevenZip = path.join(
  desktopDir,
  "node_modules",
  "7zip-bin",
  "win",
  "x64",
  "7za.exe",
);
const stagedSevenZip = path.join(stagingDir, "7za.exe");
const installScript = path.join(stagingDir, "install.vbs");
const sedFile = path.join(stagingDir, "offline-installer.sed");
const iexpress = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "iexpress.exe",
);

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.basename(command)} завершился с кодом ${code ?? "null"}` +
            (signal ? ` (сигнал ${signal})` : ""),
        ),
      );
    });
  });
}

await Promise.all([
  fs.access(path.join(unpackedDir, "ScheduleAutomator.exe")),
  fs.access(sevenZip),
  fs.access(iexpress),
]);
await fs.rm(stagingDir, { recursive: true, force: true });
await fs.mkdir(stagingDir, { recursive: true });
await fs.copyFile(sevenZip, stagedSevenZip);

await run(
  sevenZip,
  ["a", "-t7z", archivePath, ".", "-mx=9", "-mmt=on"],
  unpackedDir,
);

const vbs = `Option Explicit
Dim shell, fso, sourceDir, installDir, desktopDir, startMenuDir, exePath, exitCode
Dim desktopShortcut, startMenuShortcut, shortcut

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sourceDir = fso.GetParentFolderName(WScript.ScriptFullName)
installDir = ReadEnv("SCHEDULE_AUTOMATOR_INSTALL_DIR", shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Programs\\ScheduleAutomator")
desktopDir = ReadEnv("SCHEDULE_AUTOMATOR_DESKTOP_DIR", shell.SpecialFolders("Desktop"))
startMenuDir = ReadEnv("SCHEDULE_AUTOMATOR_START_MENU_DIR", shell.SpecialFolders("Programs"))
exePath = installDir & "\\ScheduleAutomator.exe"

If IsRunning("ScheduleAutomator.exe") Then
  MsgBox "Закройте «Конструктор расписаний» и повторите установку.", 48, "Конструктор расписаний"
  WScript.Quit 5
End If

If fso.FolderExists(installDir) Then
  fso.DeleteFolder installDir, True
End If
CreateFolders installDir

exitCode = shell.Run(Quote(sourceDir & "\\7za.exe") & " x -y -o" & Quote(installDir) & " " & Quote(sourceDir & "\\schedule-app.7z"), 0, True)
If exitCode <> 0 Or Not fso.FileExists(exePath) Then
  MsgBox "Не удалось распаковать приложение. Код: " & exitCode, 16, "Конструктор расписаний"
  WScript.Quit exitCode
End If

CreateFolders desktopDir
CreateFolders startMenuDir
desktopShortcut = desktopDir & "\\Конструктор расписаний.lnk"
startMenuShortcut = startMenuDir & "\\Конструктор расписаний.lnk"
CreateShortcut desktopShortcut, exePath
CreateShortcut startMenuShortcut, exePath

shell.Run Quote(exePath), 1, False

Sub CreateShortcut(shortcutPath, targetPath)
  Set shortcut = shell.CreateShortcut(shortcutPath)
  shortcut.TargetPath = targetPath
  shortcut.WorkingDirectory = fso.GetParentFolderName(targetPath)
  shortcut.IconLocation = targetPath & ",0"
  shortcut.Description = "Конструктор учебных расписаний"
  shortcut.Save
End Sub

Sub CreateFolders(folderPath)
  Dim parentPath
  If fso.FolderExists(folderPath) Then Exit Sub
  parentPath = fso.GetParentFolderName(folderPath)
  If Len(parentPath) > 0 And Not fso.FolderExists(parentPath) Then
    CreateFolders parentPath
  End If
  fso.CreateFolder folderPath
End Sub

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function

Function ReadEnv(name, fallback)
  Dim marker, value
  marker = "%" & name & "%"
  value = shell.ExpandEnvironmentStrings(marker)
  If Len(value) = 0 Or value = marker Then
    ReadEnv = fallback
  Else
    ReadEnv = value
  End If
End Function

Function IsRunning(processName)
  Dim tasklistPath, tasklist, output
  On Error Resume Next
  tasklistPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\tasklist.exe"
  Set tasklist = shell.Exec(Quote(tasklistPath) & " /FI " & Quote("IMAGENAME eq " & processName) & " /NH")
  output = tasklist.StdOut.ReadAll()
  If Err.Number <> 0 Then
    Err.Clear
    IsRunning = False
  Else
    IsRunning = (InStr(1, output, processName, vbTextCompare) > 0)
  End If
  On Error GoTo 0
End Function
`;
await fs.writeFile(
  installScript,
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, "utf16le")]),
);

const sourceDir = stagingDir.endsWith(path.sep)
  ? stagingDir
  : `${stagingDir}${path.sep}`;
const sed = `[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=${stagedInstallerPath}
FriendlyName=Schedule Automator
AppLaunched=wscript.exe install.vbs
PostInstallCmd=<None>
AdminQuietInstCmd=wscript.exe install.vbs
UserQuietInstCmd=wscript.exe install.vbs
SourceFiles=SourceFiles

[Strings]
FILE0="schedule-app.7z"
FILE1="7za.exe"
FILE2="install.vbs"

[SourceFiles]
SourceFiles0=${sourceDir}

[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
`;
await fs.writeFile(sedFile, sed, "utf8");
await fs.rm(installerPath, { force: true });
await fs.rm(stagedInstallerPath, { force: true });
await run(iexpress, ["/N", "/Q", sedFile], stagingDir);
await fs.copyFile(stagedInstallerPath, installerPath);

const installerStat = await fs.stat(installerPath);
if (installerStat.size < 10 * 1024 * 1024) {
  throw new Error(`Установщик получился подозрительно маленьким: ${installerStat.size}`);
}
console.log(`Автономный установщик: ${installerPath}`);
