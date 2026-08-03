import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SETTINGS_DIR = path.join(
  process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local"),
  "ScheduleAutomator",
);
const SETTINGS_FILE = path.join(SETTINGS_DIR, "export-settings.json");

type SaveDialogResult =
  | { supported: false }
  | { supported: true; canceled: true }
  | { supported: true; canceled: false; filePath: string; opened: boolean };

export type DesktopSaveHandler = (
  buffer: Buffer,
  suggestedFilename: string,
) => Promise<SaveDialogResult>;

let desktopSaveHandler: DesktopSaveHandler | null = null;

export function setDesktopSaveHandler(
  handler: DesktopSaveHandler | null,
): void {
  desktopSaveHandler = handler;
}

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function fromBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function safeFilename(value: string): string {
  const name = String(value || "Расписание.docx")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "") || "Расписание";
  return name.toLowerCase().endsWith(".docx") ? name : `${name}.docx`;
}

async function initialDirectory(): Promise<string> {
  try {
    const saved = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8"));
    if (typeof saved.lastExportDirectory === "string") {
      const stat = await fs.stat(saved.lastExportDirectory);
      if (stat.isDirectory()) return saved.lastExportDirectory;
    }
  } catch {
    // Первый экспорт или ранее выбранная папка больше недоступна.
  }
  return path.join(os.homedir(), "Downloads");
}

async function rememberDirectory(directory: string): Promise<void> {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(
    SETTINGS_FILE,
    JSON.stringify({ lastExportDirectory: directory }, null, 2),
    "utf8",
  );
}

async function chooseWindowsPath(
  directory: string,
  filename: string,
): Promise<string | null> {
  const directory64 = toBase64(directory);
  const filename64 = toBase64(filename);
  const script = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$utf8 = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'Сохранение расписания Word'
$dialog.Filter = 'Документ Microsoft Word (*.docx)|*.docx'
$dialog.DefaultExt = 'docx'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$dialog.RestoreDirectory = $true
$dialog.InitialDirectory = $utf8.GetString([Convert]::FromBase64String('${directory64}'))
$dialog.FileName = $utf8.GetString([Convert]::FromBase64String('${filename64}'))
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
try {
  $result = $dialog.ShowDialog($owner)
} finally {
  $owner.Close()
  $owner.Dispose()
}
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Convert]::ToBase64String($utf8.GetBytes($dialog.FileName))
} else {
  'CANCELLED'
}
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  const result = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  if (result === "CANCELLED") return null;
  if (!result) throw new Error("Окно сохранения не вернуло выбранный файл");
  const selectedPath = fromBase64(result);
  if (
    !path.win32.isAbsolute(selectedPath) ||
    !selectedPath.toLowerCase().endsWith(".docx")
  ) {
    throw new Error("Не удалось определить выбранный путь сохранения Word-файла");
  }
  return selectedPath;
}

async function openSavedFileAndFolder(filePath: string): Promise<boolean> {
  const filePath64 = toBase64(filePath);
  const script = `
$ErrorActionPreference = 'Stop'
$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${filePath64}'))
$directory = Split-Path -Parent $target
Start-Process -FilePath $directory
Start-Sleep -Milliseconds 300
Start-Process -FilePath $target
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return true;
  } catch {
    // Файл уже сохранен: ошибка автоматического открытия не отменяет экспорт.
    return false;
  }
}

export async function saveBufferWithDialog(
  buffer: Buffer,
  suggestedFilename: string,
): Promise<SaveDialogResult> {
  const filename = safeFilename(suggestedFilename);
  if (desktopSaveHandler) return desktopSaveHandler(buffer, filename);
  if (process.platform !== "win32") return { supported: false };

  const selectedPath = await chooseWindowsPath(
    await initialDirectory(),
    filename,
  );
  if (!selectedPath) return { supported: true, canceled: true };

  await fs.writeFile(selectedPath, buffer);
  await rememberDirectory(path.dirname(selectedPath));
  const opened = await openSavedFileAndFolder(selectedPath);
  return { supported: true, canceled: false, filePath: selectedPath, opened };
}
