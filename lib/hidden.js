// Windows hidden/system detection.
//
// On Windows "hidden" is a file attribute, not a leading dot, and Node exposes
// no way to read it - fs.Dirent and fs.stat both ignore it entirely. So a
// folder you hid in Explorer looks completely ordinary to the scanner.
//
// Asking PowerShell once per file would be unusably slow, so every path the
// library cares about (each video, and every folder above it) is checked in a
// single batched call instead. Anything marked Hidden or System, at any level,
// takes the video with it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const config = require("../config");

// Every ancestor directory of a path, up to but not including the drive root.
function ancestorsOf(filePath) {
  const out = [];
  let dir = path.dirname(filePath);
  let guard = 0;
  while (dir && guard++ < 64) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached "C:\" or "/"
    out.push(dir);
    dir = parent;
  }
  return out;
}

function runPowerShell(listFile, timeoutMs) {
  return new Promise((resolve) => {
    // -Force makes Get-Item return hidden items instead of erroring on them.
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$mask=[IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System;" +
      "Get-Content -LiteralPath '" + listFile.replace(/'/g, "''") + "' -Encoding UTF8 |" +
      " ForEach-Object { $i = Get-Item -LiteralPath $_ -Force;" +
      " if ($i -and ($i.Attributes -band $mask)) { $_ } }";

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err && !stdout ? null : String(stdout || ""))
    );
  });
}

// Returns the subset of `paths` that are hidden or system.
async function findHidden(paths, opts) {
  if (os.platform() !== "win32" || !paths.length) return new Set();

  const tmp = path.join(
    os.tmpdir(),
    "notflix-hidden-" + process.pid + "-" + Date.now() + ".txt"
  );

  try {
    fs.writeFileSync(tmp, paths.join("\n"), "utf8");
    const out = await runPowerShell(tmp, (opts && opts.timeoutMs) || 120000);
    if (out === null) return null; // PowerShell unavailable or timed out
    return new Set(
      out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase())
    );
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
  }
}

// Paths the user has explicitly excluded in config, matched as prefixes so
// listing a folder covers everything inside it.
function isManuallyExcluded(filePath) {
  const list = config.EXCLUDE_PATHS || [];
  if (!list.length) return false;
  const lower = filePath.toLowerCase();
  return list.some(p => {
    const prefix = String(p).toLowerCase().replace(/[\\/]+$/, "");
    return lower === prefix || lower.startsWith(prefix + path.sep) ||
           lower.startsWith(prefix + "/") || lower.startsWith(prefix + "\\");
  });
}

// Drops videos that are hidden, sit inside a hidden folder, or fall under one
// of the paths listed in config.EXCLUDE_PATHS.
// Returns { videos, removed, checked }.
async function filterVisible(videos) {
  const manual = [];
  const candidates = [];
  for (const v of videos) {
    if (isManuallyExcluded(v.path)) manual.push(v);
    else candidates.push(v);
  }

  if (!config.EXCLUDE_HIDDEN || os.platform() !== "win32") {
    return { videos: candidates, removed: manual.length, checked: false };
  }

  // One flat list of everything to test: the files themselves plus every
  // folder above them, de-duplicated so a shared folder is checked once.
  const toCheck = new Set();
  for (const v of candidates) {
    toCheck.add(v.path);
    for (const dir of ancestorsOf(v.path)) toCheck.add(dir);
  }

  const hidden = await findHidden([...toCheck]);
  if (hidden === null) {
    return { videos: candidates, removed: manual.length, checked: false };
  }

  const visible = candidates.filter(v => {
    if (hidden.has(v.path.toLowerCase())) return false;
    return !ancestorsOf(v.path).some(d => hidden.has(d.toLowerCase()));
  });

  return {
    videos: visible,
    removed: manual.length + (candidates.length - visible.length),
    checked: true
  };
}

module.exports = { filterVisible, findHidden, ancestorsOf, isManuallyExcluded };
