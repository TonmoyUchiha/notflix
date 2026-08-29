// Watch progress, stored on the PC rather than in each browser.
//
// Progress used to live in localStorage, which meant the phone and the PC each
// kept their own private idea of where you were. Since the PC is already the
// one machine both devices talk to, it is the natural place to keep this: every
// device reads the same map and writes back to it, so stopping an episode on
// one and picking it up on the other just works.
//
// There is a single PIN and therefore a single viewer, so one shared map is
// all this needs - no per-user separation.

const fs = require("fs");
const path = require("path");
const config = require("../config");

const dataDir = path.resolve(__dirname, "..", config.DATA_DIR);
const progressFile = path.join(dataDir, "progress.json");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// videoId -> { time, duration, at }
let entries = {};

try {
  if (fs.existsSync(progressFile)) {
    const raw = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    entries = raw.entries || {};
  }
} catch (_) {
  entries = {};
}

// Written straight to disk, not batched.
//
// This used to be debounced by a second, which lost the last position whenever
// the PC was shut down or the server was killed inside that window - i.e.
// exactly when you stop watching, shut the PC, and pick up your phone. The
// file is a few kilobytes and updates arrive every few seconds at most, so
// there is nothing to gain by holding writes back.
//
// Written to a temp file and renamed, which is atomic: a shutdown mid-write
// leaves either the old file or the new one, never a truncated one.
function persist() {
  try {
    const tmp = progressFile + ".part";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, progressFile);
  } catch (_) { /* progress is not worth crashing over */ }
}

// Anything within this many seconds of the end counts as watched, and is
// dropped so finished episodes leave the Continue Watching row.
const FINISHED_MARGIN = 20;
// Below this, you have not really started, so it is not worth resuming.
const STARTED_MARGIN = 15;

function all() {
  return entries;
}

function get(videoId) {
  return entries[videoId] || null;
}

// Records a position. `at` is set here rather than trusted from the client, so
// two devices disagreeing about the time of day cannot corrupt the ordering.
function set(videoId, time, duration) {
  const t = Number(time);
  const d = Number(duration);
  if (!videoId || !isFinite(t) || t < 0) return null;

  const finished = isFinite(d) && d > 0 && t > d - FINISHED_MARGIN;
  const barelyStarted = t < STARTED_MARGIN;

  if (finished || barelyStarted) {
    if (entries[videoId]) {
      delete entries[videoId];
      persist();
    }
    return null;
  }

  entries[videoId] = {
    time: t,
    duration: isFinite(d) && d > 0 ? d : (entries[videoId] ? entries[videoId].duration : 0),
    at: Date.now()
  };
  persist();
  return entries[videoId];
}

function clear(videoId) {
  if (entries[videoId]) {
    delete entries[videoId];
    persist();
  }
}

// Merges what a device kept while it could not reach the server. The newer
// timestamp wins, so a device that has been offline cannot roll back progress
// made elsewhere in the meantime.
function merge(incoming) {
  let changed = 0;
  for (const [id, e] of Object.entries(incoming || {})) {
    if (!e || !isFinite(Number(e.time))) continue;
    const mine = entries[id];
    const theirAt = Number(e.at) || 0;
    if (mine && Number(mine.at) >= theirAt) continue;
    entries[id] = {
      time: Number(e.time),
      duration: Number(e.duration) || 0,
      at: theirAt || Date.now()
    };
    changed++;
  }
  if (changed) persist();
  return changed;
}

// How long an entry is kept after its video stops showing up in scans.
const ORPHAN_GRACE_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months

// Keeps the map from growing forever, without throwing away history the moment
// a file is temporarily out of reach.
//
// Deleting every entry whose video is missing from the latest scan sounds
// right, but an external drive that was asleep, unplugged, or still spinning
// up during a scan would take your whole watch history for that drive with it.
// So a missing video only costs its entry after months of still being missing,
// and a scan that found nothing at all is ignored outright.
function prune(validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  if (valid.size === 0) return 0; // a failed or empty scan proves nothing

  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  let removed = 0;
  for (const [id, e] of Object.entries(entries)) {
    if (valid.has(id)) continue;
    if ((Number(e.at) || 0) > cutoff) continue; // recent - the drive may be back
    delete entries[id];
    removed++;
  }
  if (removed) persist();
  return removed;
}

module.exports = { all, get, set, clear, merge, prune, FINISHED_MARGIN, STARTED_MARGIN };
