const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const config = require("../config");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const thumbDir = path.resolve(__dirname, "..", config.THUMBNAIL_DIR);
if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

function thumbPathFor(id) {
  return path.join(thumbDir, `${id}.jpg`);
}

function thumbExists(id) {
  return fs.existsSync(thumbPathFor(id));
}

function getDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data || !data.format) return resolve(null);
      resolve(data.format.duration || null);
    });
  });
}

async function generateOne(video) {
  const outPath = thumbPathFor(video.id);
  if (fs.existsSync(outPath)) return outPath;

  const duration = await getDuration(video.path);
  const seekTo = duration
    ? Math.max(1, duration * (config.THUMBNAIL_POSITION_PERCENT / 100))
    : 5;

  return new Promise((resolve) => {
    ffmpeg(video.path)
      .on("end", () => resolve(outPath))
      .on("error", () => resolve(null)) // corrupt/unreadable video, skip quietly
      .screenshots({
        timestamps: [seekTo],
        filename: `${video.id}.jpg`,
        folder: thumbDir,
        size: "400x?"
      });
  });
}

// Processes the whole library with a small concurrency pool so we don't
// spawn 50 ffmpeg processes at once. Reports progress via onProgress.
async function generateAll(library, onProgress) {
  const queue = library.filter(v => !thumbExists(v.id));
  let done = library.length - queue.length;
  if (onProgress) onProgress({ total: library.length, done });

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const video = queue[cursor++];
      await generateOne(video);
      done++;
      if (onProgress) onProgress({ total: library.length, done });
    }
  }

  const workers = Array.from(
    { length: Math.min(config.THUMBNAIL_CONCURRENCY, queue.length) },
    worker
  );
  await Promise.all(workers);
}

module.exports = { generateAll, generateOne, thumbExists, thumbPathFor };
