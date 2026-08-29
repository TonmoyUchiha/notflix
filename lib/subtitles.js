// Subtitle discovery and conversion.
//
// Two sources: streams embedded in the file itself, and sidecar files sitting
// next to it (or in a Subs\ folder beside it). Both are converted to WebVTT on
// demand, because WebVTT is the only subtitle format a browser will render
// from a <track> element.
//
// The conversion is lossy for ASS: timing and text survive, the karaoke and
// sign styling does not. That is the accepted trade for subtitles you can
// switch on and off instantly rather than burning into the picture.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const config = require("../config");

const subsRoot = path.resolve(__dirname, "..", config.DATA_DIR, "subs");
if (!fs.existsSync(subsRoot)) fs.mkdirSync(subsRoot, { recursive: true });

const SIDECAR_EXTS = [".srt", ".ass", ".ssa", ".vtt", ".sub", ".smi", ".txt"];
// Bitmap formats carry pictures, not text, so they cannot become WebVTT.
const BITMAP_CODECS = ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"];

const SUB_FOLDERS = ["subs", "subtitles", "sub", "subtitle"];

// ISO 639-1/2 -> display name. Only the codes that actually turn up on rips.
const LANGUAGES = {
  eng: "English", en: "English",
  jpn: "Japanese", ja: "Japanese", jp: "Japanese",
  ben: "Bengali", bn: "Bengali",
  hin: "Hindi", hi: "Hindi",
  spa: "Spanish", es: "Spanish",
  fre: "French", fra: "French", fr: "French",
  ger: "German", deu: "German", de: "German",
  ita: "Italian", it: "Italian",
  por: "Portuguese", pt: "Portuguese",
  rus: "Russian", ru: "Russian",
  ara: "Arabic", ar: "Arabic",
  chi: "Chinese", zho: "Chinese", zh: "Chinese",
  kor: "Korean", ko: "Korean",
  dut: "Dutch", nld: "Dutch", nl: "Dutch",
  swe: "Swedish", sv: "Swedish", nor: "Norwegian", no: "Norwegian",
  dan: "Danish", da: "Danish", fin: "Finnish", fi: "Finnish",
  pol: "Polish", pl: "Polish", tur: "Turkish", tr: "Turkish",
  cze: "Czech", ces: "Czech", gre: "Greek", ell: "Greek",
  hun: "Hungarian", rum: "Romanian", ron: "Romanian",
  bul: "Bulgarian", hrv: "Croatian", srp: "Serbian", slo: "Slovak",
  slv: "Slovenian", est: "Estonian", lav: "Latvian", lit: "Lithuanian",
  ice: "Icelandic", mac: "Macedonian", tha: "Thai", vie: "Vietnamese",
  ind: "Indonesian", may: "Malay", heb: "Hebrew", per: "Persian",
  fas: "Persian", urd: "Urdu", tam: "Tamil", tel: "Telugu", mal: "Malayalam"
};

// ISO 639-2 -> 639-1, for the <track srclang> attribute. Truncating the
// three-letter code instead would give "bul" -> "bu" (should be "bg") and,
// worse, map Romanian ("rum") onto Russian ("ru").
const SHORT_CODES = {
  eng: "en", jpn: "ja", ben: "bn", hin: "hi", spa: "es", fre: "fr", fra: "fr",
  ger: "de", deu: "de", ita: "it", por: "pt", rus: "ru", ara: "ar",
  chi: "zh", zho: "zh", kor: "ko", dut: "nl", nld: "nl", swe: "sv",
  nor: "no", nob: "no", nno: "no", dan: "da", fin: "fi", pol: "pl",
  tur: "tr", cze: "cs", ces: "cs", gre: "el", ell: "el", hun: "hu",
  rum: "ro", ron: "ro", bul: "bg", hrv: "hr", srp: "sr", slo: "sk",
  slk: "sk", slv: "sl", est: "et", lav: "lv", lit: "lt", ice: "is",
  isl: "is", mac: "mk", mkd: "mk", tha: "th", vie: "vi", ind: "id",
  may: "ms", msa: "ms", heb: "he", per: "fa", fas: "fa", urd: "ur",
  tam: "ta", tel: "te", mal: "ml"
};

function languageName(code) {
  if (!code) return null;
  const key = String(code).toLowerCase().slice(0, 3);
  return LANGUAGES[key] || LANGUAGES[key.slice(0, 2)] || null;
}

// Two-letter code for the <track srclang> attribute.
function shortLang(code) {
  if (!code) return "";
  const key = String(code).toLowerCase().slice(0, 3);
  if (SHORT_CODES[key]) return SHORT_CODES[key];
  if (key.length === 2 && LANGUAGES[key]) return key;
  const two = key.slice(0, 2);
  return LANGUAGES[two] ? two : "";
}

// ---------------------------------------------------------------------------
// Sidecar discovery
// ---------------------------------------------------------------------------

// Sidecar names carry the language in one of several conventions:
//   "Movie.eng.srt"                 - code appended to the video's name
//   "Subs\ara.srt"                  - code alone
//   "Subs\Brazilian.por.srt"        - qualifier plus code
//   "Subs\SDH.eng.srt"              - flag plus code
//   "2_English.srt"                 - spelled out
// So rather than matching one shape, every word is examined and the first one
// that is a real language wins; the words left over become the qualifier.
function readSidecarName(subBase, videoBase) {
  let rest = subBase;
  const matchedVideo = subBase.toLowerCase().startsWith(videoBase.toLowerCase());
  if (matchedVideo) rest = subBase.slice(videoBase.length);
  rest = rest.replace(/^[\s._-]+/, "");

  const forced = /\bforced\b/i.test(rest);
  const sdh = /\b(sdh|cc|hi)\b/i.test(rest);

  const words = rest.split(/[\s._\-\][()]+/).filter(Boolean);
  let lang = null;
  const leftovers = [];

  for (const w of words) {
    const lower = w.toLowerCase();
    if (!lang) {
      // Spelled out ("English", "Portuguese")?
      const spelled = Object.entries(LANGUAGES)
        .find(([k, v]) => k.length === 3 && v.toLowerCase() === lower);
      if (spelled) { lang = spelled[0]; continue; }
      // A bare code ("eng", "por", "nob")?
      if (/^[a-z]{2,3}$/i.test(w) && languageName(lower)) { lang = lower; continue; }
    }
    if (!/^(forced|sdh|cc|hi|srt|ass|vtt)$/i.test(w)) leftovers.push(w);
  }

  return {
    lang,
    forced,
    sdh,
    // "Brazilian", "Latin American", "Simplified" - what distinguishes this
    // track from the others in the same language.
    qualifier: leftovers.join(" ").trim(),
    // A sidecar named exactly after the video is the film's own default track.
    primary: matchedVideo && !rest
  };
}

function listSidecars(videoPath) {
  const dir = path.dirname(videoPath);
  const videoBase = path.basename(videoPath).replace(/\.[^.]+$/, "");
  const found = [];

  const searchDirs = [dir];
  let siblingVideoCount = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && SUB_FOLDERS.includes(e.name.toLowerCase())) {
        searchDirs.push(path.join(dir, e.name));
      } else if (e.isFile() && config.VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) {
        siblingVideoCount++;
      }
    }
  } catch (_) { return found; }

  for (const sdir of searchDirs) {
    let entries = [];
    try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch (_) { continue; }

    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SIDECAR_EXTS.includes(ext)) continue;

      const subBase = e.name.slice(0, -ext.length);
      const matchesVideo = subBase.toLowerCase().startsWith(videoBase.toLowerCase());
      // A Subs\ folder, or a folder holding exactly one video, belongs to
      // this video whatever the subtitle files happen to be called.
      const belongsByLocation = sdir !== dir || siblingVideoCount === 1;
      if (!matchesVideo && !belongsByLocation) continue;

      const meta = readSidecarName(subBase, videoBase);
      found.push({
        kind: "external",
        file: path.join(sdir, e.name),
        lang: meta.lang,
        forced: meta.forced,
        sdh: meta.sdh,
        qualifier: meta.qualifier,
        primary: meta.primary,
        codec: ext.slice(1)
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Track list
// ---------------------------------------------------------------------------

// Builds the list the player shows. `probeInfo.subtitleStreams` comes from
// probe.js; sidecars are read from disk each time (cheap, and it means a
// subtitle dropped in later shows up without a rescan).
function listTracks(video, probeInfo) {
  const tracks = [];
  const embedded = (probeInfo && probeInfo.subtitleStreams) || [];

  embedded.forEach((s, n) => {
    const name = languageName(s.language);
    const bits = [];
    if (name) bits.push(name);
    else if (s.language && s.language !== "und") bits.push(s.language.toUpperCase());
    if (s.title && s.title.toLowerCase() !== (name || "").toLowerCase()) bits.push(s.title);
    if (s.forced) bits.push("Forced");

    tracks.push({
      id: "e" + s.index,
      kind: "embedded",
      streamIndex: s.index,
      label: bits.join(" - ") || "Track " + (n + 1),
      lang: shortLang(s.language),
      codec: s.codec,
      burnIn: BITMAP_CODECS.includes(s.codec),
      default: !!s.default
    });
  });

  listSidecars(video.path).forEach((s) => {
    const name = languageName(s.lang);
    const bits = [];
    bits.push(name || (s.qualifier ? titleCase(s.qualifier) : "Subtitles"));
    // "Portuguese - Brazilian", "Chinese - Simplified"
    if (name && s.qualifier) bits.push(titleCase(s.qualifier));
    if (s.forced) bits.push("Forced");
    if (s.sdh) bits.push("SDH");

    tracks.push({
      id: "x" + hashName(s.file),
      kind: "external",
      file: s.file,
      label: bits.join(" - "),
      lang: shortLang(s.lang),
      codec: s.codec,
      burnIn: false,
      // A sidecar named exactly after the video is the release's own default.
      default: !!s.primary
    });
  });

  // English first; within a language, the plain track outranks the SDH and
  // forced variants, so auto-selection lands on the one most people want.
  const rank = t => {
    const special = /\b(sdh|forced|cc)\b/i.test(t.label) ? 1 : 0;
    return (t.lang === "en" ? 0 : 2) + special;
  };
  tracks.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  // Deduplicate identical labels ("English", "English") so the picker is usable.
  const seen = new Map();
  for (const t of tracks) {
    const n = (seen.get(t.label) || 0) + 1;
    seen.set(t.label, n);
    if (n > 1) t.label = t.label + " " + n;
  }

  return tracks;
}

function titleCase(s) {
  return String(s).replace(/\b[a-z]/g, c => c.toUpperCase());
}

function hashName(s) {
  return require("crypto").createHash("md5").update(s).digest("hex").slice(0, 10);
}

// ---------------------------------------------------------------------------
// Conversion to WebVTT
// ---------------------------------------------------------------------------

// Sidecar .srt files are frequently not UTF-8. Anything that fails a strict
// UTF-8 decode is assumed to be Windows-1252, which covers the usual suspects.
function guessCharenc(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return null; // UTF-8 BOM
    if (buf[0] === 0xFF && buf[1] === 0xFE) return "UTF-16LE";
    if (buf[0] === 0xFE && buf[1] === 0xFF) return "UTF-16BE";
    const decoded = new TextDecoder("utf-8", { fatal: true });
    decoded.decode(buf);
    return null; // valid UTF-8
  } catch (_) {
    return "CP1252";
  }
}

function cachePath(videoId, trackId) {
  return path.join(subsRoot, videoId, trackId + ".vtt");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    const out = [];
    let err = "";
    proc.stdout.on("data", d => out.push(d));
    proc.stderr.on("data", d => { err += d.toString().slice(-400); });
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0 || !out.length) {
        return reject(new Error("ffmpeg subtitle conversion failed: " + err.slice(-200)));
      }
      resolve(Buffer.concat(out));
    });
  });
}

// ffmpeg's WebVTT encoder leaves ASS drawing/override codes behind on some
// files. They render as literal braces, so strip what survived.
function tidyVtt(text) {
  return text
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\h/g, " ");
}

// Produces (and caches) the WebVTT for one track. Returns the file path.
async function toVtt(video, track) {
  const out = cachePath(video.id, track.id);
  if (fs.existsSync(out)) return out;

  let args;
  if (track.kind === "embedded") {
    args = ["-v", "error", "-i", video.path, "-map", "0:" + track.streamIndex,
            "-c:s", "webvtt", "-f", "webvtt", "-"];
  } else {
    const charenc = guessCharenc(track.file);
    args = ["-v", "error"];
    if (charenc) args.push("-sub_charenc", charenc);
    args.push("-i", track.file, "-c:s", "webvtt", "-f", "webvtt", "-");
  }

  const buf = await runFfmpeg(args);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + ".part";
  fs.writeFileSync(tmp, tidyVtt(buf.toString("utf8")), "utf8");
  fs.renameSync(tmp, out);
  return out;
}

// Called when a video is rescanned or its file changes.
function clearCache(videoId) {
  try { fs.rmSync(path.join(subsRoot, videoId), { recursive: true, force: true }); }
  catch (_) { /* nothing cached */ }
}

module.exports = {
  listTracks, listSidecars, toVtt, clearCache,
  languageName, shortLang, BITMAP_CODECS
};
