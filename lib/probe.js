const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const config = require("../config");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const dataDir = path.resolve(__dirname, "..", config.DATA_DIR);
const probeFile = path.join(dataDir, "probe.json");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Bumped whenever the shape of a cached result changes, so an old cache is
// discarded rather than served without the fields callers now expect.
const CACHE_VERSION = 2;

let cache = {};
try {
  if (fs.existsSync(probeFile)) {
    const raw = JSON.parse(fs.readFileSync(probeFile, "utf8"));
    if (raw && raw.version === CACHE_VERSION) cache = raw.entries || {};
  }
} catch (_) { cache = {}; }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(probeFile, JSON.stringify({ version: CACHE_VERSION, entries: cache }));
    } catch (_) {}
  }, 500);
}

// What Apple's WebKit (Safari, and Chrome on iPhone, which is Safari underneath)
// will actually play without help.
const SAFE_CONTAINERS = [".mp4", ".m4v", ".mov"];
const SAFE_VIDEO = ["h264", "hevc"];
const SAFE_AUDIO = ["aac", "mp3"];

function rawProbe(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data) return resolve(null);
      resolve(data);
    });
  });
}

// Returns { duration, videoCodec, audioCodec, width, height, canDirectPlay }
async function probe(video) {
  const key = video.id;
  if (cache[key]) return cache[key];

  const data = await rawProbe(video.path);
  if (!data) {
    // Unreadable or corrupt. Mark it so we don't re-probe on every request.
    const failed = { failed: true, duration: 0, canDirectPlay: false };
    cache[key] = failed;
    persist();
    return failed;
  }

  const streams = data.streams || [];
  const vStream = streams.find(s => s.codec_type === "video");
  const aStream = streams.find(s => s.codec_type === "audio");
  const ext = path.extname(video.path).toLowerCase();

  // Kept for the subtitle picker. `index` is the absolute stream index, which
  // is what `ffmpeg -map 0:<index>` wants.
  const subtitleStreams = streams
    .filter(s => s.codec_type === "subtitle")
    .map(s => ({
      index: s.index,
      codec: s.codec_name,
      language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null,
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || null,
      default: !!(s.disposition && s.disposition.default),
      forced: !!(s.disposition && s.disposition.forced)
    }));

  const audioStreams = streams
    .filter(s => s.codec_type === "audio")
    .map(s => ({
      index: s.index,
      codec: s.codec_name,
      channels: s.channels || null,
      language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null,
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || null,
      default: !!(s.disposition && s.disposition.default)
    }));

  const videoCodec = vStream ? vStream.codec_name : null;
  const audioCodec = aStream ? aStream.codec_name : null;
  const duration = parseFloat((data.format && data.format.duration) || 0) || 0;

  const canDirectPlay =
    SAFE_CONTAINERS.includes(ext) &&
    SAFE_VIDEO.includes(videoCodec) &&
    (audioCodec === null || SAFE_AUDIO.includes(audioCodec));

  const result = {
    duration,
    videoCodec,
    audioCodec,
    width: vStream ? vStream.width : null,
    height: vStream ? vStream.height : null,
    canDirectPlay,
    subtitleStreams,
    audioStreams,
    failed: false
  };

  cache[key] = result;
  persist();
  return result;
}

function getCached(id) {
  return cache[id] || null;
}

module.exports = { probe, getCached };
