const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const config = require("./config");
const scanner = require("./lib/scanner");
const store = require("./lib/library-store");
const thumbs = require("./lib/thumbnails");
const probe = require("./lib/probe");
const transcode = require("./lib/transcode");
const subtitles = require("./lib/subtitles");
const progress = require("./lib/progress");
const mdns = require("./lib/mdns");
const watchlist = require("./lib/watchlist");

const app = express();
app.use(express.json());
app.use(session({
  secret: "notflix-" + config.PIN + "-session-key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: config.SESSION_HOURS * 60 * 60 * 1000 }
}));

// ---------- Auth ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: "Not logged in" });
}

// iOS hands HLS playback to its own native video engine, which does not always
// forward session cookies. So playback URLs also carry a short-lived token.
const playTokens = new Map(); // token -> expiry timestamp

function issuePlayToken() {
  const token = crypto.randomBytes(16).toString("hex");
  playTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return token;
}

function tokenValid(token) {
  if (!token) return false;
  const exp = playTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { playTokens.delete(token); return false; }
  return true;
}

// Accepts either a logged-in session or a valid playback token.
function requirePlayAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (tokenValid(req.query.t)) return next();
  return res.status(401).json({ error: "Not authorized" });
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of playTokens) if (now > exp) playTokens.delete(t);
}, 60 * 60 * 1000);

app.post("/api/login", (req, res) => {
  const { pin } = req.body || {};
  if (String(pin) === String(config.PIN)) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Wrong PIN" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

// ---------- Scan status / trigger ----------
let mdnsHandle = null;
let scanState = { scanning: false, filesFound: 0, skippedDirs: 0 };
let thumbState = { total: 0, done: 0, running: false };

async function runScan() {
  if (scanState.scanning) return;
  scanState = { scanning: true, filesFound: 0, skippedDirs: 0 };

  const { videos, stats } = await scanner.scanAll((p) => {
    scanState = { scanning: !p.done, ...p };
  });
  store.save(videos);
  progress.prune(new Set(videos.map(v => v.id)));
  scanState = { scanning: false, ...stats };
  console.log(
    "  Scan complete: " + videos.length + " videos, " +
    store.state.titles.length + " titles. Skipped " +
    (stats.skippedGameDirs || 0) + " game installs, " +
    (stats.skippedCodeDirs || 0) + " code folders."
  );

  if (config.THUMBNAIL_ENABLED) {
    thumbState.running = true;
    thumbs.generateAll(videos, (p) => { thumbState = { ...p, running: true }; })
      .then(() => { thumbState.running = false; });
  }
}

app.post("/api/scan", requireAuth, (req, res) => {
  runScan();
  res.json({ started: true });
});

app.get("/api/scan-status", requireAuth, (req, res) => {
  res.json({ scan: scanState, thumbnails: thumbState });
});

// ---------- Library ----------

// The compact shape the browse grid needs. The full season/episode list is
// only sent when a title is opened.
function cardOf(t) {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    category: t.category,
    year: t.year,
    poster: t.poster,
    episodeCount: t.episodeCount,
    seasonCount: t.seasonCount,
    videoId: t.videoId || null,
    hasThumbnail: t.poster ? thumbs.thumbExists(t.poster) : false
  };
}

app.get("/api/library", requireAuth, (req, res) => {
  store.load();
  const titles = store.state.titles;

  const order = Object.keys(config.CATEGORIES).filter(c => config.CATEGORIES[c]);
  const buckets = new Map(order.map(c => [c, []]));
  for (const t of titles) {
    if (!buckets.has(t.category)) buckets.set(t.category, []);
    buckets.get(t.category).push(cardOf(t));
  }

  const categories = [...buckets.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, count: items.length, items }));

  // Recently added, across everything - the one row that is not a category.
  const recent = [...titles]
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, 24)
    .map(cardOf);

  res.json({
    categories,
    recent,
    watchlist: watchlist.resolve(titles).map(cardOf),
    continueWatching: continueWatching(),
    total: titles.length,
    videoCount: store.state.videos.length,
    lastScan: store.state.lastScan
  });
});

// Built here rather than in the browser, because working out which title a
// half-watched episode belongs to needs the video-to-title index - and because
// it has to be the same row on every device.
function continueWatching() {
  const saved = progress.all();
  const rows = [];

  for (const [videoId, entry] of Object.entries(saved)) {
    const title = store.titleOfVideo(videoId);
    if (!title) continue;
    const video = store.getById(videoId);
    if (!video || !fs.existsSync(video.path)) continue;

    let label = null;
    if (title.type === "series") {
      for (const s of title.seasons) {
        const ep = s.episodes.find(e => e.id === videoId);
        if (ep) {
          label = (s.season === 0 ? "Special" : "S" + s.season) + " E" + ep.episode;
          break;
        }
      }
    }

    rows.push({
      ...cardOf(title),
      // The card plays the episode you stopped on, not the first one.
      resumeVideoId: videoId,
      resumeLabel: label,
      resumeTime: entry.time,
      resumeDuration: entry.duration,
      resumeAt: entry.at,
      poster: videoId,
      hasThumbnail: thumbs.thumbExists(videoId)
    });
  }

  // Most recently watched first; ties broken by id so the order is fixed.
  rows.sort((a, b) => (b.resumeAt || 0) - (a.resumeAt || 0) ||
                      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.slice(0, 20);
}

// ---------- Watch progress (shared across every device) ----------
app.get("/api/progress", requireAuth, (req, res) => {
  res.json({ entries: progress.all() });
});

app.post("/api/progress", requireAuth, (req, res) => {
  const { id, time, duration } = req.body || {};
  if (!id || !store.getById(id)) return res.status(404).json({ error: "Unknown video" });
  const entry = progress.set(id, time, duration);
  res.json({ ok: true, entry });
});

// Used once at startup by each device to hand over anything it recorded while
// the server was unreachable.
app.post("/api/progress/merge", requireAuth, (req, res) => {
  const merged = progress.merge((req.body || {}).entries);
  res.json({ ok: true, merged, entries: progress.all() });
});

app.delete("/api/progress/:id", requireAuth, (req, res) => {
  progress.clear(req.params.id);
  res.json({ ok: true });
});

// ---------- My List (shared across every device) ----------
app.get("/api/watchlist", requireAuth, (req, res) => {
  res.json({ items: watchlist.resolve(store.state.titles).map(cardOf) });
});

app.post("/api/watchlist/:id", requireAuth, (req, res) => {
  const title = store.getTitle(req.params.id);
  if (!title) return res.status(404).json({ error: "Unknown title" });
  const added = watchlist.toggle(title.id, title.title);
  res.json({ ok: true, inList: added });
});

app.delete("/api/watchlist/:id", requireAuth, (req, res) => {
  watchlist.remove(req.params.id);
  res.json({ ok: true, inList: false });
});

// The deepest folder every file of a title shares. For a show whose seasons
// live in sibling folders this is the show folder; for a single file it is
// simply the folder it sits in.
function commonFolder(paths) {
  if (!paths.length) return null;
  const sep = paths[0].includes("\\") ? "\\" : "/";
  const parts = paths.map(p => path.dirname(p).split(/[\\/]/));
  const first = parts[0];
  let n = 0;
  while (n < first.length &&
         parts.every(p => n < p.length && p[n].toLowerCase() === first[n].toLowerCase())) {
    n++;
  }
  const folder = first.slice(0, n).join(sep);
  // "F:" alone is not a folder; give it its trailing separator back.
  return /^[a-z]:$/i.test(folder) ? folder + sep : (folder || null);
}

// The part of a path below `folder`, which is what actually tells you where
// one episode sits relative to the rest of the show.
function relativeTo(folder, fullPath) {
  if (!folder) return fullPath;
  const trimmed = folder.replace(/[\\/]+$/, "");
  if (fullPath.toLowerCase().startsWith(trimmed.toLowerCase())) {
    return fullPath.slice(trimmed.length).replace(/^[\\/]+/, "");
  }
  return fullPath;
}

app.get("/api/title/:id", requireAuth, (req, res) => {
  const title = store.getTitle(req.params.id);
  if (!title) return res.status(404).json({ error: "Not found" });

  const paths = store.episodesOf(title)
    .map(id => store.getById(id))
    .filter(Boolean)
    .map(v => v.path);
  const folder = commonFolder(paths);

  const decorate = e => {
    const video = store.getById(e.id);
    return {
      ...e,
      hasThumbnail: thumbs.thumbExists(e.id),
      path: video ? video.path : null,
      // Shown under each episode so it is obvious which folder it came from.
      relPath: video ? relativeTo(folder, video.path) : null,
      missing: !video || !fs.existsSync(video.path)
    };
  };

  const movieVideo = title.type === "movie" ? store.getById(title.videoId) : null;

  res.json({
    ...title,
    hasThumbnail: title.poster ? thumbs.thumbExists(title.poster) : false,
    inList: watchlist.has(title.id),
    folder,
    path: movieVideo ? movieVideo.path : null,
    fileCount: paths.length,
    seasons: title.seasons.map(s => ({ ...s, episodes: s.episodes.map(decorate) }))
  });
});

app.get("/api/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });

  const results = store.state.titles
    .filter(t => t.title.toLowerCase().includes(q))
    .sort((a, b) => {
      // Titles that start with the query rank above ones that merely contain it.
      const as = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || a.sortTitle.localeCompare(b.sortTitle);
    })
    .slice(0, 60)
    .map(cardOf);

  res.json({ results });
});

// ---------- Thumbnails ----------
app.get("/api/thumb/:id", (req, res) => {
  const p = thumbs.thumbPathFor(req.params.id);
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).end();
});

// ---------- Playback ----------

// What plays after this one, so the player can offer "Next episode".
function nextEpisodeOf(videoId) {
  const title = store.titleOfVideo(videoId);
  if (!title || title.type !== "series") return null;
  const ids = store.episodesOf(title);
  const i = ids.indexOf(videoId);
  if (i < 0 || i + 1 >= ids.length) return null;

  const nextId = ids[i + 1];
  for (const s of title.seasons) {
    const ep = s.episodes.find(e => e.id === nextId);
    if (ep) {
      return {
        id: nextId,
        title: title.title,
        label: (s.season === 0 ? "Special" : "S" + s.season) +
               " E" + ep.episode + " - " + ep.title
      };
    }
  }
  return null;
}

app.get("/api/playinfo/:id", requireAuth, async (req, res) => {
  const video = store.getById(req.params.id);
  if (!video || !fs.existsSync(video.path)) {
    return res.status(404).json({ error: "This video is no longer on your PC. Try a rescan." });
  }

  const info = await probe.probe(video);
  if (info.failed) {
    return res.status(422).json({
      error: "This file couldn't be read. It may be corrupt or still copying."
    });
  }

  const token = issuePlayToken();
  const tracks = config.SUBTITLES_ENABLED ? subtitles.listTracks(video, info) : [];

  // Bitmap subtitles (PGS/VOBSUB) are pictures, so they cannot become WebVTT.
  // They have to be drawn into the frame, which means transcoding.
  const textTracks = tracks.filter(t => !t.burnIn);
  const burnTracks = tracks.filter(t => t.burnIn);

  const payload = {
    duration: info.duration,
    title: video.filename,
    next: nextEpisodeOf(video.id),
    subtitles: textTracks.map(t => ({
      id: t.id,
      label: t.label,
      lang: t.lang,
      url: "/api/subs/" + video.id + "/" + t.id + ".vtt?t=" + token,
      default: t.default
    })),
    burnInSubtitles: burnTracks.map(t => ({ id: t.id, label: t.label, lang: t.lang })),
    defaultSubtitleLanguage: config.SUBTITLE_DEFAULT_LANGUAGE
  };

  if (info.canDirectPlay) {
    return res.json({
      ...payload,
      mode: "direct",
      url: "/api/stream/" + video.id + "?t=" + token
    });
  }

  res.json({
    ...payload,
    mode: "hls",
    url: "/api/hls/" + video.id + "/index.m3u8?t=" + token,
    token,
    reason: "Converting " + String(info.videoCodec || "video").toUpperCase() + " for your device"
  });
});

// ---------- Subtitles ----------
app.get("/api/subs/:id/:track.vtt", requirePlayAuth, async (req, res) => {
  const video = store.getById(req.params.id);
  if (!video) return res.status(404).end();

  const info = probe.getCached(video.id) || await probe.probe(video);
  const track = subtitles.listTracks(video, info).find(t => t.id === req.params.track);
  if (!track) return res.status(404).end();
  if (track.burnIn) {
    return res.status(415).send("This subtitle track is image-based and has to be burned in.");
  }

  try {
    const file = await subtitles.toVtt(video, track);
    res.set("Content-Type", "text/vtt; charset=utf-8");
    res.set("Cache-Control", "public, max-age=86400");
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error("Subtitle conversion failed:", err.message);
    res.status(500).send("Could not convert this subtitle track.");
  }
});

// ---------- HLS playlist + segments ----------
app.get("/api/hls/:id/index.m3u8", requirePlayAuth, async (req, res) => {
  const video = store.getById(req.params.id);
  if (!video) return res.status(404).end();

  const info = probe.getCached(video.id) || await probe.probe(video);
  if (!info || !info.duration) {
    return res.status(422).send("Could not read this video's length.");
  }

  const token = tokenValid(req.query.t) ? req.query.t : issuePlayToken();
  const burn = req.query.burn || null;

  res.set("Content-Type", "application/vnd.apple.mpegurl");
  res.set("Cache-Control", "no-cache");
  res.send(transcode.buildPlaylist(video.id, info.duration, token, burn));
});

app.get("/api/hls/:id/seg:index.ts", requirePlayAuth, async (req, res) => {
  const video = store.getById(req.params.id);
  if (!video) return res.status(404).end();

  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0) return res.status(400).end();

  const info = probe.getCached(video.id) || await probe.probe(video);

  // Burning a subtitle track in means a different set of segments, so they
  // are cached under their own key.
  let burnTrack = null;
  if (req.query.burn) {
    burnTrack = subtitles.listTracks(video, info).find(t => t.id === req.query.burn) || null;
  }

  try {
    const file = await transcode.transcodeSegment(video, info, index, burnTrack);
    res.set("Content-Type", "video/mp2t");
    res.set("Cache-Control", "public, max-age=86400");
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error("Segment error:", err.message);
    res.status(500).end();
  }
});

// ---------- Streaming (range-request aware, so scrubbing/seeking works) ----------
app.get("/api/stream/:id", requirePlayAuth, (req, res) => {
  const video = store.getById(req.params.id);
  if (!video || !fs.existsSync(video.path)) {
    return res.status(404).json({ error: "Video not found" });
  }

  const stat = fs.statSync(video.path);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(video.path).toLowerCase();
  const mimeMap = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".mov": "video/quicktime",
    ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t",
    ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg"
  };
  const contentType = mimeMap[ext] || "application/octet-stream";

  if (!range) {
    res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType });
    return fs.createReadStream(video.path).pipe(res);
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    "Content-Range": "bytes " + start + "-" + end + "/" + fileSize,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": contentType
  });
  fs.createReadStream(video.path, { start, end }).pipe(res);
});

// ---------- Static frontend (PWA shell) ----------
app.use(express.static(path.join(__dirname, "public")));

app.listen(config.PORT, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach(list => list.forEach(iface => {
    if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
  }));

  console.log("\n  NOTFLIX is running.\n");
  console.log("  On this PC:      http://localhost:" + config.PORT);

  if (config.MDNS_ENABLED) {
    // The address to actually save on the phone: it survives the router
    // handing this PC a different IP, which a saved home-screen icon does not.
    const name = String(config.HOSTNAME || "notflix").replace(/\.local\.?$/i, "") + ".local";
    console.log("  On your phone:   http://" + name + ":" + config.PORT + "   <- add this one");
    ips.forEach(ip => console.log("  (or by IP:       http://" + ip + ":" + config.PORT + ")"));
    mdnsHandle = mdns.start(config.HOSTNAME || "notflix");
  } else {
    ips.forEach(ip => console.log("  On your phone:   http://" + ip + ":" + config.PORT));
  }

  console.log("\n  PIN: " + config.PIN + "  (change it in config.js)");
  console.log("  Both devices must be on the same WiFi network.\n");

  transcode.cleanupOldCache();

  const cached = store.load();
  if (cached.length === 0) {
    console.log("  No library cached yet - starting first scan in the background...\n");
    runScan();
  } else {
    console.log("  " + cached.length + " videos in " + store.state.titles.length + " titles.");
    // Hidden/system files can only be spotted by asking Windows, so a cached
    // library gets re-checked at startup rather than waiting for a rescan.
    store.purgeHidden().then(({ removed, checked }) => {
      if (removed) {
        console.log("  Removed " + removed + " hidden file(s). Now " +
                    store.state.videos.length + " videos in " +
                    store.state.titles.length + " titles.");
      } else if (!checked) {
        console.log("  (Could not read Windows hidden attributes - skipped that check.)");
      }
      console.log("");
    });
  }
});

// Ctrl+C: withdraw the local name so phones stop being told this PC is here.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (mdnsHandle) mdnsHandle.stop();
    setTimeout(() => process.exit(0), 150);
  });
}
