// What is this file, and does it belong in the library at all?
//
// Notflix has no metadata database, so everything here is inference from the
// path, the folder it lives in, and what else sits beside it on disk.
//
// Two separate jobs:
//   1. Rejection - game assets, code-project media, app resources. A wrong
//      "yes" here means junk on the home screen, so these rules are specific.
//   2. Categorisation - Movies / TV Shows / Anime / Clips / Other. A wrong
//      answer is only a cosmetic annoyance, so these rules are looser and
//      score-based, with series-level voting applied later by the grouper.

const path = require("path");
const naming = require("./naming");

// ---------------------------------------------------------------------------
// Directory fingerprints
//
// The scanner hands us the entry listing it already read, so recognising a
// game install or a code checkout costs nothing extra. When a directory is
// recognised, the scanner prunes the whole subtree - which is what actually
// keeps VALORANT's menu clips and a React project's hero video out.
// ---------------------------------------------------------------------------

// Files that only exist inside a shipped game.
const GAME_MARKER_FILES = [
  "unityplayer.dll", "unitycrashhandler64.exe", "unitycrashhandler32.exe",
  "steam_api.dll", "steam_api64.dll", "steamclient.dll", "steam_appid.txt",
  "gameoverlayrenderer.dll", "galaxy64.dll", "galaxy.dll",
  "d3d11.dll", "xinput1_3.dll",
  "renpy.exe", "game.exe", "nw.dll", "libcef.dll",
  "eossdk-win64-shipping.dll", "eossdk-win32-shipping.dll"
];

// Directory names that only exist inside a shipped game.
const GAME_MARKER_DIRS = [
  "renpy", "steamapps", "unrealengine", "engine",
  "shootergame", "binaries", "paks", "streamingassets", "mono"
];

const GAME_MARKER_EXTS = [".pck", ".rpa", ".rpyc", ".uasset", ".pak", ".vpk", ".bik", ".usm", ".assets"];

// Files that mean "this is source code, not a media folder".
const CODE_MARKER_FILES = [
  "package.json", "tsconfig.json", "jsconfig.json", "yarn.lock",
  "package-lock.json", "pnpm-lock.yaml", "bun.lockb",
  "requirements.txt", "pyproject.toml", "pipfile", "setup.py",
  "cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json",
  "gemfile", "pubspec.yaml", "cmakelists.txt", "makefile", "dockerfile",
  ".gitignore", ".editorconfig", "webpack.config.js", "vite.config.js",
  "vite.config.ts", "next.config.js", "angular.json"
];

const CODE_MARKER_EXTS = [".sln", ".csproj", ".vcxproj", ".xcodeproj"];

// Given `fs.Dirent[]` for one directory, what kind of place is this?
//
// Two tiers of game evidence, counted separately:
//   - named markers (GAME_MARKER_FILES): specific files like
//     "steam_api64.dll" or "unityplayer.dll" that essentially only exist
//     inside a real game install. Strong signal on their own.
//   - extension markers (GAME_MARKER_EXTS): generic engine-asset extensions
//     like .vpk, .pak, .bik. Weak on their own - a stray downloaded shader
//     cache file, or a single leftover asset someone dragged into a folder,
//     matches these with nothing else about the folder being game-like. They
//     only count once something else (an .exe, a game-named subfolder)
//     corroborates them.
function fingerprintDir(entries) {
  let hasExe = false, namedMarkers = 0, extMarkers = 0, gameDirs = 0, codeFiles = 0;
  let hasRenpyDir = false, hasGameDir = false, hasDataDir = false;

  for (const e of entries) {
    const name = e.name.toLowerCase();
    const ext = path.extname(name);

    if (e.isDirectory()) {
      if (GAME_MARKER_DIRS.includes(name)) gameDirs++;
      if (name === "renpy") hasRenpyDir = true;
      if (name === "game") hasGameDir = true;
      // Unity ships "<GameName>_Data" next to "<GameName>.exe".
      if (/_data$/.test(name)) hasDataDir = true;
      continue;
    }

    if (ext === ".exe") hasExe = true;
    if (GAME_MARKER_FILES.includes(name)) namedMarkers++;
    if (GAME_MARKER_EXTS.includes(ext)) extMarkers++;
    if (CODE_MARKER_FILES.includes(name)) codeFiles++;
    if (CODE_MARKER_EXTS.includes(ext)) codeFiles++;
  }

  const corroborated = hasExe || hasDataDir || gameDirs > 0 || hasRenpyDir;

  const isGameRoot =
    (hasExe && (hasDataDir || namedMarkers > 0 || extMarkers > 0 || gameDirs > 0)) ||
    (hasRenpyDir && hasGameDir) ||
    namedMarkers >= 2 ||
    (extMarkers >= 2 && corroborated) ||
    hasDataDir;

  return { isGameRoot, isCodeRoot: codeFiles >= 1, hasExe };
}

// ---------------------------------------------------------------------------
// Path backstops
//
// fingerprintDir only fires when we walk the game's own root. These catch the
// cases where scanning starts *below* it, and let us re-filter an already
// saved library.json without a full rescan.
// ---------------------------------------------------------------------------

const GAME_PATH_RE = [
  /[\\/]steamapps[\\/]/i,
  /[\\/]riot games[\\/]/i,
  /[\\/]epic games[\\/]/i,
  /[\\/]gog (galaxy|games)[\\/]/i,
  /[\\/](origin|ea) games[\\/]/i,
  /[\\/]ea desktop[\\/]/i,
  /[\\/]ubisoft([\\/]|.*game launcher)/i,
  /[\\/]battle\.net[\\/]/i,
  /[\\/]rockstar games[\\/]/i,
  /[\\/]shootergame[\\/]/i,
  /[\\/]content[\\/]movies?[\\/]/i,
  /[\\/]content[\\/]paks[\\/]/i,
  /[\\/]binaries[\\/]win(32|64)[\\/]/i,
  /[\\/]streamingassets[\\/]/i,
  /[\\/][^\\/]+_data[\\/]/i,          // Unity: MyGame_Data\...
  /[\\/]renpy[\\/]/i,
  /[\\/][^\\/]*-pc[\\/]game[\\/]/i,   // Ren'Py distribution: Title-1.0-pc\game\
  /[\\/]game[\\/](images|movies|video|audio)[\\/]/i,
  /[\\/]www[\\/]movies[\\/]/i,        // RPG Maker MV
  /[\\/]riot client[\\/]/i,
  /[\\/]splash-?screens?[\\/]/i
];

const JUNK_PATH_RE = [
  /[\\/]node_modules[\\/]/i,
  /[\\/]resources[\\/](app|assets)[\\/]/i,
  /[\\/]app\.asar/i,
  /[\\/]common files[\\/]/i,
  /[\\/]documents[\\/]adobe[\\/]/i,
  /[\\/]adobe[\\/][^\\/]+[\\/]tutorial[\\/]/i,
  /[\\/]program files( \(x86\))?[\\/]/i,
  /[\\/]windowsapps[\\/]/i,
  /[\\/](plug-?ins?|presets?)[\\/]/i,
  /[\\/](dist|build|out|target|coverage)[\\/]/i,
  /[\\/]\.(venv|tox|next|nuxt|gradle|m2)[\\/]/i,
  /[\\/]vendor[\\/]/i,
  /[\\/]site-packages[\\/]/i,
  /[\\/]public[\\/](video|videos|assets|media)[\\/]/i,
  /[\\/]static[\\/](video|videos|media)[\\/]/i
];

// Names that give away an asset rather than something you would sit and watch.
const ASSET_NAME_RE = /^(splash|logo|intro|outro|loading|menu|title|bg|background|preview|thumb|teaser|placeholder|test|sample|watermark)[\s._-]|(_loop|_bg|_anim|-loop)\b/i;

function isGamePath(p) {
  return GAME_PATH_RE.some(re => re.test(p));
}

function isJunkPath(p) {
  return JUNK_PATH_RE.some(re => re.test(p));
}

// ---------------------------------------------------------------------------
// Category signals
// ---------------------------------------------------------------------------

// Fansub groups and release tags that reliably mean anime. Matched with or
// without brackets, since some rips use (Group) or @Group instead.
const FANSUB_RE = /[[(@]\s*(subsplease|erai-?raws|horriblesubs|judas|asw|ember|coalgirls|commie|nightcoat|animeout|whynot|aks|judgment|cyber12|l@?mbert|sos|iamtsukasa|doki|chihiro|underwater|deadfish|mtbb|hakata ?ramen|anime ?time|kaizoku|puyasubs|ohys-?raws|golumpa|yameii|beatrice-?raws|sallysubs|exiled-?destiny|hi10|hi10p)\b/i;

const ANIME_WORD_RE = /\b(anime|ova|oav|oad|ncop|nced|shounen|shoujo|seinen|josei|monogatari|gakuen|sensei|senpai|kouhai|nakama|isekai|shinigami|nakama)\b/i;

// A CRC32 checksum in brackets - "(E9EA961E)", "[A1B2C3D4]" - is a fansub
// convention and essentially never appears on anything else.
const CRC32_RE = /[[(][0-9A-F]{8}[\])]/;

// Japanese particles and honorifics inside a romanised title. Deliberately
// narrow: broader stems like /\bshi\w*/ would match "ship" and "shirt".
const ROMAJI_RE = /(?:^|\s)(?:no|wa|ga|wo|ni|de|kara|made|yori|kimi|boku|ore|watashi|kono|sono|ano)(?:\s|$)|[\s-](?:san|chan|kun|sama|senpai|sensei|tan|hime|dono)\b/i;

const CLIP_PATH_RE = /[\\/](nvidia replays?|shadowplay|obs[\s_-]?records?|radeon relive|medal|captures|xbox game bar|game ?dvr|clips?)[\\/]/i;

// "2019-09-25 19-06-38.flv" is how OBS names a capture, and Windows Game Bar
// appends ".DVR" to everything it records - both are gameplay, wherever the
// folder happens to be.
const CLIP_NAME_RE = /^\d{4}-\d{2}-\d{2}[\s_]\d{2}-\d{2}-\d{2}|\.dvr\.[a-z0-9]+$|[\s._-]dvr[\s._-]/i;

const HOME_PATH_RE = /[\\/](dcim|camera roll|camera uploads|whatsapp video|screen ?recordings?|logicapture|my videos)[\\/]/i;
const HOME_NAME_RE = /^(vid|img|mov|pxl|dsc|movi|wa)[\s_-]?\d{4}|^(screen ?record|screenshot|camera recording|recording)\b|^\d{8}[_-]\d{6}/i;

const TUTORIAL_PATH_RE = /[\\/](tutorials?|courses?|udemy|coursera|lynda|pluralsight|masterclass|lessons?|training|learn[\s_-])|[\s._-]week[\s._-]*\d{1,2}\b/i;

// The trailing "_6_min" is the Coursera download convention. An underscore is
// a word character, so `\b_\d+_min\b` never matches and the separators have to
// be spelled out.
const TUTORIAL_NAME_RE = /\b(tutorial|lecture|lesson|course|how to|getting started)\b|\bepisode \d+ of\b|\bpart \d+ -|[_\s.-]\d{1,3}[_\s.-]?min(?:s|utes)?\b|[_\s.-]week[_\s.-]*\d{1,2}\b/i;

const MUSIC_PATH_RE = /[\\/](songs?|music|music ?videos?|mv|albums?|discography)[\\/]/i;

// Returns a plain object of boolean/score signals for one file.
function signals(fullPath) {
  const base = path.basename(fullPath);
  const dir = path.dirname(fullPath);
  const parsed = naming.parseEpisode(base);

  const noExt = base.replace(/\.[^.]+$/, "");
  const cleanBase = naming.cleanName(noExt);

  // Scored rather than boolean: no single filename convention is conclusive,
  // but three weak hints together are. The grouper adds series- and
  // library-level votes on top of this.
  let anime = 0;
  if (FANSUB_RE.test(fullPath)) anime += 3;
  if (/[\\/]anime[\\/]/i.test(fullPath)) anime += 3;
  if (CRC32_RE.test(noExt)) anime += 3;
  if (ANIME_WORD_RE.test(fullPath)) anime += 2;
  if (ROMAJI_RE.test(cleanBase)) anime += 2;
  // Fansub numbering (" - 07 ") rather than western SxxExx.
  if (parsed.episode !== null && parsed.season === null &&
      /[\s._]-[\s._]*\d{1,3}(v\d)?(?=[\s._[(]|$)/.test(noExt)) anime += 1;
  // A bracketed release tag in front of an episode-numbered file.
  if (parsed.episode !== null && /^\s*[[(]/.test(noExt)) anime += 1;
  if (/\[(bd|bdrip|bd ?rip)\]/i.test(noExt)) anime += 1;
  if (parsed.episode !== null &&
      /\b(eng(lish)? ?sub(bed|s)?|eng(lish)? ?dub(bed)?|sub_?dub|uncensored)\b/i.test(fullPath)) anime += 1;

  return {
    parsed,
    anime,
    isClip: CLIP_PATH_RE.test(dir) || CLIP_NAME_RE.test(base),
    isHome: HOME_PATH_RE.test(dir) || HOME_NAME_RE.test(base),
    isTutorial: TUTORIAL_PATH_RE.test(dir) || TUTORIAL_NAME_RE.test(base),
    isMusic: MUSIC_PATH_RE.test(dir),
    isAsset: ASSET_NAME_RE.test(base),
    year: naming.parseYear(base)
  };
}

// The category a single file would get on its own. The grouper may override
// this once it can see the whole series.
function categorise(fullPath, sig) {
  const s = sig || signals(fullPath);
  if (s.isClip) return "Clips";
  if (s.isHome) return "Home Videos";
  if (s.isTutorial) return "Tutorials";
  if (s.isMusic) return "Music Videos";
  if (s.anime >= 3) return "Anime";
  if (s.parsed.episode !== null) return s.anime >= 2 ? "Anime" : "TV Shows";
  if (s.year) return "Movies";
  return "Other";
}

// Should this file be in the library at all?
// `dirKind` is the fingerprintDir result for the containing directory, when
// the caller has one (the scanner does; a re-filter pass does not).
function shouldInclude(fullPath, dirKind) {
  if (isGamePath(fullPath)) return { ok: false, reason: "game" };
  if (isJunkPath(fullPath)) return { ok: false, reason: "junk" };
  if (dirKind && dirKind.isGameRoot) return { ok: false, reason: "game" };
  if (dirKind && dirKind.isCodeRoot) return { ok: false, reason: "junk" };
  // Asset-looking names are only rejected when nothing suggests real content.
  const base = path.basename(fullPath);
  if (ASSET_NAME_RE.test(base) && !naming.parseYear(base) &&
      naming.parseEpisode(base).episode === null) {
    return { ok: false, reason: "asset" };
  }
  return { ok: true, reason: null };
}

module.exports = {
  fingerprintDir, isGamePath, isJunkPath, shouldInclude,
  signals, categorise,
  prettyTitle: naming.prettyTitle
};
