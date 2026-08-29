// The "My List" watchlist.
//
// Kept on the PC rather than in each browser, for the same reason watch
// progress is: saving something on your phone should mean it is there on your
// PC too.
//
// A title's id is derived from its name (for shows) or its file path (for
// movies), so a rescan that renames a show - or a file that moves - would
// otherwise orphan the entry silently. Each entry therefore stores the title
// text alongside the id, and a lookup that misses by id falls back to matching
// by name and repairs itself.

const fs = require("fs");
const path = require("path");
const config = require("../config");

const dataDir = path.resolve(__dirname, "..", config.DATA_DIR);
const listFile = path.join(dataDir, "watchlist.json");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// [{ id, title, addedAt }] - an array, because the order things were added is
// worth keeping.
let items = [];

try {
  if (fs.existsSync(listFile)) {
    const raw = JSON.parse(fs.readFileSync(listFile, "utf8"));
    items = Array.isArray(raw.items) ? raw.items : [];
  }
} catch (_) {
  items = [];
}

// Written immediately and atomically, so pulling the plug cannot lose or
// corrupt the list.
function persist() {
  try {
    const tmp = listFile + ".part";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }));
    fs.renameSync(tmp, listFile);
  } catch (_) { /* not worth crashing over */ }
}

function normalise(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function has(id) {
  return items.some(i => i.id === id);
}

function add(id, title) {
  if (!id || has(id)) return false;
  items.push({ id, title: title || null, addedAt: Date.now() });
  persist();
  return true;
}

function remove(id) {
  const before = items.length;
  items = items.filter(i => i.id !== id);
  if (items.length === before) return false;
  persist();
  return true;
}

function toggle(id, title) {
  if (has(id)) { remove(id); return false; }
  add(id, title);
  return true;
}

function all() {
  return items;
}

// Resolves saved entries against the current library, newest first.
// `titles` is the live title list; anything that cannot be found at all is
// left in the file (the drive may simply be unplugged) but not returned.
function resolve(titles) {
  const byId = new Map(titles.map(t => [t.id, t]));
  const byName = new Map(titles.map(t => [normalise(t.title), t]));
  let repaired = false;

  const found = [];
  for (const entry of items) {
    let title = byId.get(entry.id);

    // The id changed - a show was renamed by a scan, or a movie file moved.
    // Match on the name instead and adopt the new id so it sticks next time.
    if (!title && entry.title) {
      title = byName.get(normalise(entry.title));
      if (title) { entry.id = title.id; repaired = true; }
    }
    if (title) found.push({ entry, title });
  }

  if (repaired) persist();
  return found
    .sort((a, b) => (b.entry.addedAt || 0) - (a.entry.addedAt || 0))
    .map(f => f.title);
}

module.exports = { all, has, add, remove, toggle, resolve };
