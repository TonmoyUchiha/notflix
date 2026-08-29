const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const config = require("../config");
const classifier = require("./classifier");
const hidden = require("./hidden");

function makeId(fullPath) {
  return crypto.createHash("md5").update(fullPath).digest("hex");
}

// Finds every existing drive root on the machine (Windows: C:\, D:\, ...).
// On non-Windows platforms it just returns the user's home directory.
function detectDrives() {
  if (os.platform() === "win32") {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const root = String.fromCharCode(i) + ":\\";
      try {
        if (fs.existsSync(root)) drives.push(root);
      } catch (_) { /* inaccessible drive, skip */ }
    }
    return drives;
  }
  return [os.homedir()];
}

function isExcludedDir(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith(".")) return true; // hidden folder
  return config.EXCLUDE_DIR_NAMES.includes(lower);
}

// ".ts" is both MPEG transport stream and TypeScript. Every MPEG-TS packet is
// 188 bytes and starts with 0x47, so two sync bytes settle it - which keeps
// `index.d.ts` out of the library without banning real .ts recordings.
async function isTransportStream(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const buf = Buffer.alloc(377);
    const { bytesRead } = await handle.read(buf, 0, 377, 0);
    if (bytesRead < 377) return false;
    return buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47;
  } catch (_) {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Ordinal, case-insensitive, with a case-sensitive tiebreak so that two names
// differing only in case still have one fixed order. Deliberately NOT
// localeCompare: that varies with the machine's locale, which would make the
// same drive scan differently on a different PC.
function byName(a, b) {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  if (al < bl) return -1;
  if (al > bl) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// `isRoot` marks a directory the user actually pointed the scanner at (a
// whole drive, or an entry in SCAN_ROOTS) as opposed to a folder discovered
// while walking. Fingerprint pruning is never applied there: it exists to
// skip a *specific* game install or project checkout, and a scan root is
// neither of those things - it is "everything under here." A false positive
// on an ordinary subfolder costs that one folder; a false positive on a
// drive root costs the whole drive, so the one place the heuristic is not
// allowed to act is exactly the place its mistake would be catastrophic.
async function walk(dir, onFile, stats, isRoot) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    stats.skippedDirs++;
    stats.unreadable.push(dir);
    return; // permission denied / unreadable, just move on
  }

  // readdir returns whatever order the filesystem hands back, which is not
  // guaranteed and can change as files are added and removed. Sorting here
  // means two scans of an unchanged drive produce byte-identical results, and
  // that a file always lands in the same place it did last time.
  entries.sort((a, b) => byName(a.name, b.name));

  // We already have the listing, so recognising a game install or a code
  // checkout is free - and pruning the whole subtree here is what actually
  // keeps VALORANT's menu clips and a web app's hero video out of the library.
  // A scan root is exempted from the prune (see the note on `isRoot` above),
  // but still gets a real fingerprint so per-file checks below behave exactly
  // as they would for any other folder - a stray .vpk loose at a drive root
  // is still correctly ignored as an asset, just without taking the whole
  // drive down with it.
  const kind = classifier.fingerprintDir(entries);
  if (!isRoot) {
    if (kind.isGameRoot) { stats.skippedGameDirs++; return; }
    if (kind.isCodeRoot) { stats.skippedCodeDirs++; return; }
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      await walk(full, onFile, stats);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!config.VIDEO_EXTENSIONS.includes(ext)) continue;

    const verdict = classifier.shouldInclude(full, kind);
    if (!verdict.ok) {
      stats.rejected[verdict.reason] = (stats.rejected[verdict.reason] || 0) + 1;
      continue;
    }

    try {
      const st = await fsp.stat(full);
      if (st.size < config.MIN_FILE_SIZE_BYTES) {
        stats.rejected.tiny = (stats.rejected.tiny || 0) + 1;
        continue;
      }
      if (ext === ".ts" && !(await isTransportStream(full))) {
        stats.rejected.notVideo = (stats.rejected.notVideo || 0) + 1;
        continue;
      }
      stats.filesFound++;
      onFile({ fullPath: full, size: st.size, mtime: st.mtimeMs });
    } catch (_) {
      // unreadable file, skip
    }
  }
}

function emptyStats() {
  return {
    filesFound: 0, skippedDirs: 0, skippedGameDirs: 0, skippedCodeDirs: 0,
    rejected: {},
    // Folders the OS refused to list, kept so a missing video can be explained
    // rather than silently vanishing.
    unreadable: []
  };
}

// Scans configured roots (or every drive) and returns the flat video list.
// onProgress(partialStats) is called about once a second during the walk.
async function scanAll(onProgress) {
  const roots = (config.SCAN_ROOTS.length ? config.SCAN_ROOTS.slice() : detectDrives())
    .sort(byName);
  const stats = emptyStats();
  const videos = [];
  const tick = onProgress ? setInterval(() => onProgress({ ...stats }), 1000) : null;

  for (const root of roots) {
    await walk(root, (file) => {
      videos.push({
        id: makeId(file.fullPath),
        path: file.fullPath,
        filename: path.basename(file.fullPath),
        size: file.size,
        mtime: file.mtime
      });
    }, stats, /* isRoot */ true);
  }

  // Windows hidden/system attributes are invisible to readdir, so they are
  // checked in one batch once the walk knows which files it is considering.
  const visible = await hidden.filterVisible(videos);
  if (visible.removed) stats.rejected.hidden = visible.removed;
  stats.hiddenChecked = visible.checked;

  // The library is handed on in a fixed order, so everything downstream -
  // grouping, category shelves, which episode wins a duplicate - is decided
  // the same way every time regardless of how the walk happened to run.
  visible.videos.sort((a, b) => byName(a.path, b.path));
  stats.unreadable.sort(byName);

  if (tick) clearInterval(tick);
  if (onProgress) onProgress({ ...stats, done: true });
  return { videos: visible.videos, stats };
}

module.exports = { scanAll, detectDrives, makeId, isTransportStream };

// Allow `npm run scan` to run this as a standalone sanity check.
if (require.main === module) {
  const grouper = require("./grouper");
  console.log("Scanning for videos... this can take a while on a full drive scan.\n");
  scanAll((s) => {
    process.stdout.write(
      "\rFiles found: " + s.filesFound +
      "   (unreadable folders: " + s.skippedDirs +
      ", game installs skipped: " + s.skippedGameDirs +
      ", code folders skipped: " + s.skippedCodeDirs + ")   "
    );
  }).then(({ videos, stats }) => {
    console.log("\n\nDone. " + videos.length + " videos kept.");
    console.log("Rejected:", stats.rejected);
    const titles = grouper.build(videos);
    const byCat = {};
    titles.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + 1; });
    console.log(titles.length + " titles:", byCat);
  });
}
