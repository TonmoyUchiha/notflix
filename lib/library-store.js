const fs = require("fs");
const path = require("path");
const config = require("../config");
const grouper = require("./grouper");
const classifier = require("./classifier");
const hidden = require("./hidden");

const dataDir = path.resolve(__dirname, "..", config.DATA_DIR);
const libraryFile = path.join(dataDir, "library.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// The library is stored twice over: `videos` is the flat list of files (what
// playback needs, keyed by id) and `titles` is the grouped view (what the
// browse screen needs). Grouping is cheap enough to redo on load, so only the
// flat list is authoritative.
let state = {
  videos: [],
  titles: [],
  byVideoId: new Map(),
  byTitleId: new Map(),
  lastScan: null
};

function reindex() {
  state.byVideoId = new Map(state.videos.map(v => [v.id, v]));
  state.byTitleId = new Map(state.titles.map(t => [t.id, t]));
  state.titleOfVideoId = new Map();
  for (const t of state.titles) {
    for (const vid of episodesOf(t)) state.titleOfVideoId.set(vid, t.id);
  }
}

// Ordinal path order, matching the scanner's. Grouping decisions (which name
// a folder votes for, which duplicate wins) are then fixed by the paths
// themselves rather than by the order the files happened to arrive in.
function byPath(a, b) {
  const al = a.path.toLowerCase(), bl = b.path.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function regroup() {
  state.videos.sort(byPath);
  state.titles = grouper.build(state.videos);
  reindex();
}

// A library saved before the current filtering rules may still contain game
// assets, project media or TypeScript files. Re-checking on load means those
// disappear immediately instead of waiting for the next full rescan.
function filterExisting(videos) {
  return videos.filter(v => {
    if (!classifier.shouldInclude(v.path, null).ok) return false;
    if (path.extname(v.path).toLowerCase() === ".ts" && !isTransportStreamSync(v.path)) return false;
    return true;
  });
}

function isTransportStreamSync(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(377);
    if (fs.readSync(fd, buf, 0, 377, 0) < 377) return false;
    return buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function load() {
  if (!fs.existsSync(libraryFile)) return state.videos;
  try {
    const raw = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
    // Accept the older format, which stored only a flat "library" array.
    const stored = raw.videos || raw.library || [];
    const kept = filterExisting(stored);
    const dropped = stored.length - kept.length;
    if (dropped > 0) {
      console.log("  Filtered out " + dropped + " game/project files from the cached library.");
    }
    state.videos = kept;
    state.lastScan = raw.lastScan || null;
    // Titles are always rebuilt rather than read back from the file. Grouping
    // 4,000 files takes about a second, and trusting the saved copy means any
    // improvement to the naming or categorising rules silently does nothing
    // until the next full rescan.
    regroup();
  } catch (_) {
    state.videos = [];
    state.titles = [];
    reindex();
  }
  return state.videos;
}

function save(videos) {
  state.videos = videos;
  state.lastScan = new Date().toISOString();
  regroup();
  const tmp = libraryFile + ".part";
  fs.writeFileSync(tmp, JSON.stringify({
    videos: state.videos,
    titles: state.titles,
    lastScan: state.lastScan
  }));
  fs.renameSync(tmp, libraryFile);
}

function getById(id) {
  return state.byVideoId.get(id) || null;
}

function getTitle(id) {
  return state.byTitleId.get(id) || null;
}

// Every video id belonging to a title, in play order.
function episodesOf(title) {
  if (!title) return [];
  if (title.type === "movie") return [title.videoId];
  return title.seasons.flatMap(s => s.episodes.map(e => e.id));
}

// Which title does this video belong to? Used to play the next episode.
function titleOfVideo(videoId) {
  const id = state.titleOfVideoId && state.titleOfVideoId.get(videoId);
  return id ? state.byTitleId.get(id) || null : null;
}

// Drops hidden/system files and anything under config.EXCLUDE_PATHS from an
// already-cached library, so they disappear without waiting for a full rescan.
// Async because reading Windows file attributes means shelling out.
async function purgeHidden() {
  const before = state.videos.length;
  const result = await hidden.filterVisible(state.videos);
  if (result.videos.length === before) return { removed: 0, checked: result.checked };

  state.videos = result.videos;
  regroup();
  try {
    const tmp = libraryFile + ".part";
    fs.writeFileSync(tmp, JSON.stringify({
      videos: state.videos,
      titles: state.titles,
      lastScan: state.lastScan
    }));
    fs.renameSync(tmp, libraryFile);
  } catch (_) { /* keep the in-memory result even if the write fails */ }

  return { removed: before - state.videos.length, checked: result.checked };
}

module.exports = {
  load, save, getById, getTitle, episodesOf, titleOfVideo,
  regroup, purgeHidden, state
};
