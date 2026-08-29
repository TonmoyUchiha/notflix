// Filename & folder-name parsing primitives.
//
// Everything Notflix knows about a video comes from its path, so this file is
// where the guessing happens. It is deliberately conservative: it would rather
// leave a field null than invent a wrong season number.

const path = require("path");

// Release / encoding noise that should never survive into a displayed title.
const RELEASE_TOKENS = [
  "1080p", "1080i", "720p", "480p", "360p", "2160p", "4k", "uhd",
  "x264", "x265", "h264", "h265", "avc", "hevc", "xvid", "divx",
  "10bit", "8bit", "hi10p", "hi10",
  "webdl", "web-dl", "web-hd", "webhd", "webrip", "bluray", "blu-ray", "bdrip",
  "brrip", "dvdrip", "dvdscr", "hdrip", "hdtv", "remux", "raw", "hd",
  "proper", "repack", "internal", "limited", "unrated", "uncut", "uncensored",
  "aac", "aac2", "ac3", "eac3", "dts", "dd5", "ddp5", "flac", "opus",
  "dual", "multi", "sub", "subs", "subbed", "msubs", "esubs", "dub", "dubbed",
  "softsub", "softsubs", "hardsub", "hardsubs",
  "complete", "batch", "collection",
  "yify", "yts", "rarbg", "ettv", "eztv", "psa", "qxr", "tigole", "joy",
  "ntb", "amzn", "dsnp", "hmax", "hulu", "atvp", "mkvcinemas", "galaxyrg",
  "pahe", "pahe.in", "encoded", "reencoded"
];

// Words that trail a folder name to describe what else is in the box:
// "Darker Than Black Complete Series & OVA" -> "Darker Than Black".
// "offline" and a bare "extra" are deliberately absent: they are real words in
// titles such as "Sword Art Offline", and trimming them there turns the show
// into "Sword Art".
const FOLDER_TAIL_RE = /\s*(?:[&+,]|\band\b)?\s*\b(ova|ovas|oad|specials?|extras|movies?|films?|nc(?:op|ed)|openings?|endings?|bonus)\b\s*[+&,]*\s*$/i;

// "-" and "." inside a token are allowed to appear as either character.
// Longest first, so "pahe.in" is tried before "pahe" and does not leave ".in"
// stranded in the title.
const RELEASE_RE = new RegExp(
  "\\b(" + RELEASE_TOKENS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.-]/g, "[.-]?"))
    .join("|") + ")\\b",
  "gi"
);

// Multi-word noise: "Eng Sub", "English Dubbed", "5.1", "Dual Audio".
const PHRASE_RE = /\b(eng(lish)?[\s._-]*(sub(bed|s)?|dub(bed|s)?)|jap(anese)?[\s._-]*audio|dual[\s._-]*audio|\d\.\d(ch)?|complete[\s._-]*series)\b/gi;

const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;

// ---------------------------------------------------------------------------
// Episode / season markers, most specific first. Whatever text came before the
// marker is taken to be the show name.
// ---------------------------------------------------------------------------
const EPISODE_MATCHERS = [
  // S01E02, S1E2, S01.E02, S01 E02, S01E02E03
  { re: /\bs(\d{1,2})[\s._-]*e(\d{1,3})(?:[\s._-]?e?\d{1,3})?\b/i, season: 1, episode: 2 },
  // 1x02
  { re: /\b(\d{1,2})x(\d{2,3})\b/, season: 1, episode: 2 },
  // Season 1 Episode 2
  { re: /\bseason[\s._-]*(\d{1,2})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,3})\b/i, season: 1, episode: 2 },
  // Episode 12 / Ep 12 / Ep.12  (no season named)
  { re: /\b(?:episode|epi|ep)[\s._-]*(\d{1,3})\b/i, season: null, episode: 1 },
  // The whole filename is the number: "F:\Log Horizon\Season 1\01.mkv"
  { re: /^(\d{1,3})(?:v\d)?\s*$/, season: null, episode: 1 },
  // Leading number: "01-We Can't Make Any Friends", "02_Cost_Function_8_min".
  // Four-digit years cannot reach this rule, and anything above 200 is
  // rejected below, so "1917" and "300" stay movies.
  { re: /^(\d{1,3})(?:v\d)?[\s._-]/, season: null, episode: 1 },
  // " - 12 " / " - 12v2 " - the anime fansub convention
  { re: /[\s._]-[\s._]*(\d{1,3})(?:v\d)?(?=[\s._[(]|$)/, season: null, episode: 1 },
  // Trailing bare number: "Bakuman 01", "Haikyuu!! 07 [720p]"
  { re: /[\s._](\d{1,3})(?:v\d)?\s*$/, season: null, episode: 1 },
  // Last resort: a number standing alone between separators, which is how
  // "Accel World_01_HD.mkv" hides its episode number. Years are filtered out
  // by the >200 check, and a whole folder has to agree before the grouper
  // acts on this.
  { re: /[\s._](\d{1,3})(?:v\d)?[\s._](?=\D|$)/, season: null, episode: 1 }
];

// A folder name that is entirely a season label.
const SEASON_FOLDER_RE = [
  /^s(?:eason)?[\s._-]*(\d{1,2})$/i,
  /^season[\s._-]*(\d{1,2})\b/i,
  /^r(\d)$/i,                                       // Code Geass R1 / R2
  /^part[\s._-]*(\d{1,2})$/i,
  /^(?:the[\s._-]*)?(\d{1,2})(?:st|nd|rd|th)[\s._-]*season\b/i
];

// A season label sitting at the END of a show name: "Code Geass R2",
// "Bakuman S3", "K-ON Season 02", "Kuroshitsuji 2nd Season".
const SEASON_SUFFIX_RE = [
  /[\s._-]+season[\s._-]*(\d{1,2})\s*$/i,
  /[\s._-]+s(\d{1,2})\s*$/i,
  /[\s._-]+r(\d)\s*$/i,
  /[\s._-]+part[\s._-]*(\d{1,2})\s*$/i,
  /[\s._-]+(\d{1,2})(?:st|nd|rd|th)[\s._-]*season\s*$/i
];

// Folder names that are containers, not shows.
const NON_SHOW_FOLDER_RE = /^(specials?|extras?|bonus|ova|ovas|oad|ncop|nced|nc|openings?|endings?|movies?|films?|episodes?|video|videos|new folder.*|sub|subs|subtitles|dub|dubbed|hd|sd|1080p?|720p?|480p?|4k|raw|batch|complete|season|series|disc\s*\d+|cd\d+|vol(?:ume)?[\s._-]*\d+|anime|animes|cartoons?|tv|tv ?shows?|shows?|downloads?|downloading|torrents?|media|library|my ?videos?|documents?|desktop|users?|public)$/i;

function stripBrackets(s) {
  return String(s)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    // "L@mBerT", "@NightCoat" - the whole tag goes, not just the part after @.
    .replace(/\w*@[\w.-]+/g, " ");
}

// Audio tags survive the token sweep because the channel count fuses to them:
// "AAC5.1" has no word boundary between "AAC" and "5".
const AUDIO_TAG_RE = /\b(aac|ac3|eac3|dts(?:-?hd)?|dd|ddp|truehd|atmos)[\s._-]*\d(?:[\s._-]*\d)?\b/gi;

// Audio-language labels on multi-language rips: "S01 E01 ... Hindi English".
const LANGUAGE_WORD_RE = /\b(english|hindi|bengali|bangla|japanese|spanish|french|german|italian|portuguese|russian|arabic|chinese|korean|dutch|swedish|norwegian|danish|finnish|polish|turkish|tamil|telugu|malayalam|urdu|punjabi|marathi|kannada|org|esub|msub)\b/gi;

function stripReleaseNoise(s) {
  return String(s)
    .replace(PHRASE_RE, " ")
    .replace(AUDIO_TAG_RE, " ")
    .replace(RELEASE_RE, " ");
}

// True when a leftover fragment is nothing but language/format noise, so it
// should not be shown as an episode's title.
function isOnlyNoise(s) {
  const stripped = tidy(String(s || "").replace(LANGUAGE_WORD_RE, " ").replace(/\d+/g, " "));
  return stripped.replace(/[^a-z]/gi, "").length < 3;
}

function tidy(s) {
  return String(s || "")
    .replace(/[._]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—,&+]+/, "")
    .replace(/[\s\-–—,&+]+$/, "")
    .trim();
}

// Drops "01. " / "1 - " style ordering prefixes used on folder names.
function stripOrderPrefix(s) {
  return String(s).replace(/^\s*\d{1,3}\s*[.)_\-]\s*(?=\D)/, "");
}

// Cleans a raw name (file or folder) down to something displayable.
function cleanName(raw, opts) {
  const keepYear = !!(opts && opts.keepYear);
  let s = stripOrderPrefix(String(raw || ""));
  const yearHit = keepYear
    ? (s.match(/[([](19\d{2}|20\d{2})[)\]]/) || s.match(YEAR_RE))
    : null;
  s = stripBrackets(s);
  s = s.replace(/\([^)]*\)/g, " ");
  s = stripReleaseNoise(s);
  s = tidy(s);
  if (yearHit) {
    s = tidy(s.split(yearHit[1]).join(" "));
    if (s) s += " (" + yearHit[1] + ")";
  }
  return tidy(s);
}

// Splits a trailing season label off a show name.
// "Code Geass R2" -> { name: "Code Geass", season: 2 }
function splitSeasonSuffix(name) {
  const s = String(name || "");
  for (const re of SEASON_SUFFIX_RE) {
    const hit = s.match(re);
    if (!hit) continue;
    const season = parseInt(hit[1], 10);
    const stripped = tidy(s.slice(0, hit.index));
    // Refuse to strip if nothing meaningful would be left ("S2" alone).
    if (stripped.length >= 2 && isFinite(season)) {
      return { name: stripped, season };
    }
  }
  return { name: tidy(s), season: null };
}

// Blanks out bracketed/parenthesised groups and @tags so that [1-25],
// (BD_720p) and (E9EA961E) cannot be mistaken for episode numbers - while
// keeping every character offset intact, so the show name is still sliceable.
function maskNoise(s) {
  const blank = m => " ".repeat(m.length);
  return String(s)
    .replace(/\[[^\]]*\]/g, blank)
    .replace(/\{[^}]*\}/g, blank)
    .replace(/\([^)]*\)/g, blank)
    .replace(/\w*@[\w.-]+/g, blank);
}

// Returns { season, episode, showGuess, matchIndex }; any field may be null.
function parseEpisode(filename) {
  const noExt = String(filename).replace(/\.[^.]+$/, "");
  const masked = maskNoise(noExt);

  for (const m of EPISODE_MATCHERS) {
    const hit = masked.match(m.re);
    if (!hit) continue;

    const episode = parseInt(hit[m.episode], 10);
    if (!isFinite(episode)) continue;
    // A year swept up by the bare-number rule is not an episode.
    if (m.season === null && episode > 200) continue;

    const at = hit.index;
    const rawBefore = at > 0 ? noExt.slice(0, at) : "";
    const cleaned = cleanName(rawBefore);
    const split = splitSeasonSuffix(cleaned);

    let season = m.season !== null ? parseInt(hit[m.season], 10) : null;
    if (!isFinite(season)) season = null;
    if (season === null && split.season !== null) season = split.season;

    return {
      season,
      episode,
      showGuess: split.name || null,
      matchIndex: at
    };
  }
  return { season: null, episode: null, showGuess: null, matchIndex: -1 };
}

// Season number implied by a whole folder name, or null.
function parseSeasonFolder(name) {
  // "DTB_Season 1" has no word boundary before "Season" until the underscore
  // becomes a space, so normalise separators before matching.
  const s = tidy(stripOrderPrefix(String(name)));
  for (const re of SEASON_FOLDER_RE) {
    const hit = s.match(re);
    if (hit) {
      const n = parseInt(hit[1], 10);
      if (isFinite(n)) return n;
    }
  }
  // "Season 1 Episode(1-25) English Dubbed" and similar verbose folder names.
  const loose = s.match(/\bseason[\s._-]*(\d{1,2})\b/i);
  if (loose) {
    const n = parseInt(loose[1], 10);
    if (isFinite(n)) return n;
  }
  return null;
}

// True if this folder describes a season / release / container, not a show.
function isContainerFolder(name) {
  const s = tidy(stripOrderPrefix(String(name)));
  if (parseSeasonFolder(s) !== null) return true;
  if (NON_SHOW_FOLDER_RE.test(s)) return true;
  if ((s.match(/\[[^\]]*\]/g) || []).length >= 2) return true;
  if (/\bcomplete\b|\bbatch\b|episode\s*\(|\bep\s*\(|\(\d+\s*-\s*\d+\)|\[\d+\s*-\s*\d+\]/i.test(s)) return true;
  // A bare episode range on the end: "Your Lie in April 1-22".
  if (/\s\d{1,3}\s*-\s*\d{1,3}\s*$/.test(s)) return true;
  if (/\b(season|episode)\b/i.test(s)) return true;
  return false;
}

// Folder names very often bury the show name in front of a season marker:
//   "Sword Art Online - Season 1 (720p) HD (Eng Dub) BrRip + SAO Extras"
//   "Attack On Titan season 1 Episode(1-25) English Dubbed"
// Both should yield { name: "...", season: 1 }.
function splitAtSeasonMarker(name) {
  const s = tidy(stripOrderPrefix(String(name || "")));
  // "S01 E01-10" on a folder is a whole-season batch, so unlike a filename the
  // trailing episode marker does not disqualify it.
  const hit = s.match(/\b(?:season|series|part)[\s._-]*(\d{1,2})\b|\bs(\d{1,2})[\s._-]*e\d{1,3}|\bs(\d{1,2})\b/i);
  if (!hit || hit.index === 0) return { name: null, season: null };
  const season = parseInt(hit[1] || hit[2] || hit[3], 10);
  const before = cleanName(s.slice(0, hit.index));
  if (!before || before.replace(/[^a-z0-9]/gi, "").length < 3) {
    return { name: null, season: isFinite(season) ? season : null };
  }
  return { name: before, season: isFinite(season) ? season : null };
}

// cleanName, plus the trailing "& OVA", "+ Specials", "Complete Series" tails
// that folder names collect and filenames do not.
function cleanFolderName(name) {
  let s = cleanName(name);
  for (let i = 0; i < 3; i++) {
    const next = tidy(s.replace(FOLDER_TAIL_RE, ""));
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

function parseYear(name) {
  const paren = String(name).match(/[([](19\d{2}|20\d{2})[)\]]/);
  if (paren) return parseInt(paren[1], 10);
  const bare = String(name).match(YEAR_RE);
  if (bare) {
    const y = parseInt(bare[1], 10);
    if (y >= 1900 && y <= new Date().getFullYear() + 2) return y;
  }
  return null;
}

// Longest common prefix across names, backed off to a word boundary.
function commonPrefix(names) {
  if (!names.length) return "";
  let prefix = names[0];
  for (let k = 1; k < names.length; k++) {
    const n = names[k];
    let i = 0;
    while (i < prefix.length && i < n.length &&
           prefix[i].toLowerCase() === n[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  // Back off to the last separator so we never cut mid-word.
  const cut = prefix.search(/[^\s._-]*$/);
  if (cut > 0) prefix = prefix.slice(0, cut);
  return tidy(prefix);
}

// Normalised key used to merge the same show found under different spellings.
function showKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Recordings are named after the moment they were made:
//   "Screen Recording 2026-08-18 215752"  ->  "Screen Recording - 18 Aug 2026"
//   "VID_20221023_153047"                 ->  "VID - 23 Oct 2022"
// Running those through the year logic produces "Recording -08-18 215752
// (2026)", so they get handled before it.
const TIMESTAMP_RE = /(19\d{2}|20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[\s_-]*\d{2}[-_.:]?\d{2}(?:[-_.:]?\d{2})?)?/;

function prettyTitle(filename) {
  const noExt = path.basename(String(filename)).replace(/\.[^.]+$/, "");

  const stamp = noExt.match(TIMESTAMP_RE);
  if (stamp) {
    const label = tidy(noExt.slice(0, stamp.index).replace(/[._]+/g, " "));
    const date = Number(stamp[3]) + " " + MONTHS[Number(stamp[2]) - 1] + " " + stamp[1];
    return label ? label + " - " + date : date;
  }

  return cleanName(noExt, { keepYear: true }) || noExt;
}

module.exports = {
  cleanName, cleanFolderName, tidy, stripBrackets, stripReleaseNoise,
  stripOrderPrefix, maskNoise,
  parseEpisode, parseSeasonFolder, isContainerFolder, parseYear,
  splitSeasonSuffix, splitAtSeasonMarker, commonPrefix, showKey, prettyTitle,
  isOnlyNoise, YEAR_RE
};
