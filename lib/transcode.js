// On-demand HLS transcoding.
//
// Instead of converting a whole video up front (slow) or streaming the raw
// file (which iPhones often can't decode), Notflix splits the video into
// short segments and transcodes each one only when the player asks for it.
// Playback starts in a couple of seconds and you can seek anywhere instantly,
// because any segment can be produced independently.
//
// Finished segments are cached on disk, so rewatching costs nothing.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const config = require("../config");

const hlsRoot = path.resolve(__dirname, "..", config.DATA_DIR, "hls");
if (!fs.existsSync(hlsRoot)) fs.mkdirSync(hlsRoot, { recursive: true });

const SEG = config.SEGMENT_SECONDS;

// Tracks segments currently being produced so two simultaneous requests for
// the same segment don't spawn two ffmpeg processes.
const inFlight = new Map();

function segmentCount(duration) {
  return Math.max(1, Math.ceil(duration / SEG));
}

// The token has to be repeated on every segment URL. iOS hands HLS playback to
// its own native player, which resolves these URLs itself and does not reliably
// send session cookies, so without the token each segment would come back 401.
function buildPlaylist(id, duration, token, burnTrackId) {
  const count = segmentCount(duration);
  const params = [];
  if (token) params.push("t=" + encodeURIComponent(token));
  if (burnTrackId) params.push("burn=" + encodeURIComponent(burnTrackId));
  const suffix = params.length ? "?" + params.join("&") : "";
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${SEG}`,
    "#EXT-X-MEDIA-SEQUENCE:0"
  ];
  for (let i = 0; i < count; i++) {
    const remaining = duration - i * SEG;
    const len = Math.min(SEG, remaining);
    lines.push(`#EXTINF:${len.toFixed(3)},`);
    lines.push(`seg${i}.ts${suffix}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

// Segments with subtitles drawn into them are a different picture, so they get
// their own cache folder rather than colliding with the clean ones.
function segDir(id, burnTrackId) {
  return path.join(hlsRoot, burnTrackId ? id + "_sub-" + burnTrackId : id);
}
function segPath(id, index, burnTrackId) {
  return path.join(segDir(id, burnTrackId), `seg${index}.ts`);
}

function buildArgs(video, probeInfo, index, burnTrack) {
  const start = index * SEG;
  const args = [];

  // Burning subtitles in means overlaying the subtitle stream onto the video,
  // which only lines up if the original timestamps are carried through.
  if (burnTrack) args.push("-copyts");
  args.push("-ss", String(start), "-i", video.path, "-t", String(SEG));

  // Video: always re-encode to H.264 settings every iPhone can decode.
  if (burnTrack && burnTrack.kind === "embedded") {
    args.push("-filter_complex", `[0:v:0][0:${burnTrack.streamIndex}]overlay[v]`);
    args.push("-map", "[v]");
  } else if (burnTrack && burnTrack.file) {
    const escaped = burnTrack.file
      .replace(/\\/g, "/")
      .replace(/:/g, "\\\\:")
      .replace(/'/g, "\\\\'");
    args.push("-vf", `subtitles='${escaped}'`);
    args.push("-map", "0:v:0");
  } else {
    args.push("-map", "0:v:0");
  }
  args.push("-c:v", "libx264");
  args.push("-preset", config.TRANSCODE_PRESET);
  args.push("-crf", String(config.TRANSCODE_CRF));
  args.push("-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p");

  // Downscale only if the source is taller than our cap. Computed in JS so we
  // avoid fragile ffmpeg filter expressions.
  // (Skipped when burning subtitles in, because the filter slot is taken -
  // subtitles are rendered at the source resolution instead.)
  const h = probeInfo && probeInfo.height ? probeInfo.height : null;
  if (!burnTrack && h && h > config.TRANSCODE_MAX_HEIGHT) {
    args.push("-vf", `scale=-2:${config.TRANSCODE_MAX_HEIGHT}`);
  }

  // Audio: optional mapping, since some files have no audio track at all.
  args.push("-map", "0:a:0?", "-c:a", "aac", "-ac", "2", "-b:a", "128k");

  // No subtitle streams in the transport stream.
  args.push("-sn");

  // Shift timestamps so this chunk lands at the right point on the timeline.
  // With -copyts the source timestamps are already correct, so shifting again
  // would double the offset.
  if (!burnTrack) args.push("-output_ts_offset", String(start));
  args.push("-muxdelay", "0", "-muxpreload", "0");
  args.push("-f", "mpegts", "-");

  return args;
}

function transcodeSegment(video, probeInfo, index, burnTrack) {
  const burnId = burnTrack ? burnTrack.id : null;
  const out = segPath(video.id, index, burnId);
  if (fs.existsSync(out)) return Promise.resolve(out);

  const key = `${video.id}:${burnId || "-"}:${index}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = new Promise((resolve, reject) => {
    fs.mkdirSync(segDir(video.id, burnId), { recursive: true });
    const tmp = out + ".part";
    const args = buildArgs(video, probeInfo, index, burnTrack);
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => { stderr += d.toString().slice(-500); });

    proc.on("error", (err) => {
      inFlight.delete(key);
      reject(err);
    });

    proc.on("close", (code) => {
      inFlight.delete(key);
      if (code !== 0 || chunks.length === 0) {
        return reject(new Error(`ffmpeg failed on segment ${index}: ${stderr.slice(-200)}`));
      }
      try {
        // Write to a .part file first, then rename, so a half-written segment
        // is never served if the server dies mid-transcode.
        fs.writeFileSync(tmp, Buffer.concat(chunks));
        fs.renameSync(tmp, out);
        resolve(out);
      } catch (err) {
        reject(err);
      }
    });
  });

  inFlight.set(key, job);
  return job;
}

// Deletes cached segments older than the configured age, so the cache doesn't
// grow forever. Runs once at startup.
function cleanupOldCache() {
  if (!config.HLS_CACHE_DAYS) return;
  const cutoff = Date.now() - config.HLS_CACHE_DAYS * 24 * 60 * 60 * 1000;
  let dirs = [];
  try { dirs = fs.readdirSync(hlsRoot); } catch (_) { return; }
  for (const d of dirs) {
    const full = path.join(hlsRoot, d);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch (_) { /* already gone, ignore */ }
  }
}

module.exports = { buildPlaylist, transcodeSegment, segPath, segmentCount, cleanupOldCache, SEG };
