// Turns the flat list of scanned files into browsable "titles".
//
// A title is either a movie (one file) or a series (seasons -> episodes).
// The hard part is deciding what a series is *called*, because the answer is
// spread across the filename and the folder chain and neither is reliable
// alone:
//
//   F:\Bakuman\S1\Bakuman 01.mkv                    -> folder says the name
//   F:\DTB\Darker Than Black Complete...\DTB 01.mkv -> filename says the name
//   G:\RAW\ANIME\<many different shows>             -> neither; group per file
//
// So we gather candidates from both, score them, and let a whole directory of
// files vote.

const path = require("path");
const crypto = require("crypto");
const naming = require("./naming");
const classifier = require("./classifier");
const config = require("../config");

function hashId(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

// Walks up from an episode's folder looking for the folder that names the show,
// stepping over season folders ("S1"), release folders ("... [1-25] [720p] ...")
// and genre folders ("ANIME").
//
// Returns the best name found, the season it implies, every container name we
// stepped over (some of those spell the show out in full when the folder we
// land on is an acronym), and the show folder's own path.
function climbToShowFolder(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  const sep = dir.includes("\\") ? "\\" : "/";
  let seasonFromFolder = null;
  const alts = [];

  for (let i = parts.length - 1; i >= 1; i--) {
    const name = parts[i];
    if (/^[a-z]:$/i.test(name)) break; // drive roots are never show names

    const asSeason = naming.parseSeasonFolder(name);
    if (asSeason !== null && seasonFromFolder === null) seasonFromFolder = asSeason;

    if (naming.isContainerFolder(name)) {
      // "Sword Art Online - Season 1 (720p) ..." still names the show.
      const split = naming.splitAtSeasonMarker(name);
      if (split.season !== null && seasonFromFolder === null) seasonFromFolder = split.season;
      if (split.name) alts.push(split.name);
      else {
        const cleaned = naming.cleanFolderName(name);
        if (cleaned) alts.push(cleaned);
      }
      continue;
    }

    // "House of the Dragon S01 E01-10 WebRip ..." names the show in front of a
    // season marker even though it is not a plain season folder.
    const marker = naming.splitAtSeasonMarker(name);
    if (marker.season !== null && seasonFromFolder === null) seasonFromFolder = marker.season;

    const split = marker.name
      ? { name: marker.name, season: null }
      : naming.splitSeasonSuffix(naming.cleanFolderName(name));
    if (split.season !== null && seasonFromFolder === null) seasonFromFolder = split.season;

    // "D:\Violet Evergarden\1 Violet Evergarden\", "\2 OVA ...\", "\3 Movie ...\"
    // are numbered parts of the show one level up, not four separate shows. The
    // leading number only counts as ordering if there is a real show folder
    // above to climb to - which keeps "12 Monkeys" in Downloads intact.
    const numbered = /^\s*\d{1,2}[\s._-]/.test(name);
    const parent = i >= 2 ? parts[i - 1] : null;
    if (numbered && parent && !/^[a-z]:$/i.test(parent) && !naming.isContainerFolder(parent)) {
      alts.push(split.name);
      const up = naming.splitSeasonSuffix(naming.cleanFolderName(parent));
      if (up.name) {
        if (up.season !== null && seasonFromFolder === null) seasonFromFolder = up.season;
        return {
          name: up.name,
          season: seasonFromFolder,
          alts,
          depth: i - 1,
          showDir: parts.slice(0, i).join(sep)
        };
      }
    }

    // When the folder we landed on was "<Show> Season 1" / "<Show> R2", the
    // show itself lives one level up. Getting this right matters beyond the
    // name: showDir's parent is the shelf that votes on whether a run of
    // shows is anime, and a per-show folder would be a shelf of one.
    const strippedSeason = marker.name !== null || split.season !== null;
    const depth = strippedSeason && i >= 2 ? i - 1 : i;

    return {
      name: split.name,
      season: seasonFromFolder,
      alts,
      depth,
      showDir: parts.slice(0, depth + 1).join(sep)
    };
  }
  return { name: null, season: seasonFromFolder, alts, depth: -1, showDir: dir };
}

// Is this folder an extras/specials bucket hanging off a real show?
function isSpecialsFolder(dir) {
  const leaf = path.basename(dir);
  return /^(specials?|extras?|bonus|ova|ovas|oad|nc(op|ed)?|openings?|endings?|movies?)$/i.test(leaf.trim());
}

// A folder-derived name that is really an acronym ("DTB", "SAO II") is worse
// than whatever the filenames say.
function looksLikeAbbreviation(name) {
  if (!name) return true;
  const letters = name.replace(/[^a-z]/gi, "");
  if (letters.length <= 4 && name === name.toUpperCase()) return true;
  return letters.length < 3;
}

// Decides the series name for one directory of episode files.
// Returns name === null when the directory holds several different shows, so
// the caller falls back to grouping each file on its own.
function resolveSeriesName(dir, files) {
  const folder = climbToShowFolder(dir);

  // Candidate A: what the filenames themselves claim, if most of them agree.
  const guesses = files.map(f => f.sig.parsed.showGuess).filter(Boolean);
  const tally = new Map();
  for (const g of guesses) {
    const k = naming.showKey(g);
    if (!k) continue;
    const cur = tally.get(k) || { name: g, count: 0 };
    cur.count++;
    tally.set(k, cur);
  }
  // Ties are broken by name so the winner never depends on which file the
  // directory listing happened to return first.
  const best = [...tally.values()]
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  const agrees = best && best.count >= Math.max(2, Math.ceil(guesses.length * 0.6));
  const fromFiles = agrees ? best.name : null;

  // A grab-bag folder ("G:\RAW\ANIME") holds many shows at once. Naming it
  // after the folder would fuse them all into one fake series.
  if (!fromFiles && tally.size >= 3) {
    return { name: null, seasonHint: folder.season, showDir: folder.showDir };
  }

  // Candidate B: the longest shared prefix of the cleaned filenames.
  let fromPrefix = null;
  if (files.length >= 2) {
    const cleaned = files.map(f => naming.cleanName(path.basename(f.path).replace(/\.[^.]+$/, "")));
    const split = naming.splitSeasonSuffix(naming.commonPrefix(cleaned));
    if (split.name && split.name.replace(/[^a-z]/gi, "").length >= 3) fromPrefix = split.name;
  }

  // Candidate C: a container folder we stepped over that spells the show out
  // ("DTB" the folder, "Darker Than Black Complete Series & OVA" the box).
  const spelledOut = folder.alts
    .filter(a => !looksLikeAbbreviation(a))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0] || null;

  const ordered = looksLikeAbbreviation(folder.name)
    ? [fromFiles, fromPrefix, spelledOut, folder.name].filter(n => n && !looksLikeAbbreviation(n))
        .concat([fromFiles, folder.name, spelledOut].filter(Boolean))
    : [folder.name, fromFiles, fromPrefix, spelledOut].filter(Boolean);

  return {
    name: ordered[0] || null,
    seasonHint: folder.season,
    showDir: folder.showDir
  };
}

// Strips the show name and the episode marker off a filename, leaving whatever
// the episode was actually called.
function episodeTitle(filePath, showName, episodeNo) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  let s = naming.cleanName(base);

  if (showName) {
    const re = new RegExp("^" + showName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    s = naming.tidy(s.replace(re, ""));
  }
  s = naming.tidy(s
    .replace(/\bs\d{1,2}[\s._-]*e\d{1,3}\b/i, " ")
    .replace(/\b\d{1,2}x\d{2,3}\b/, " ")
    .replace(/\bseason[\s._-]*\d{1,2}\b/i, " ")
    .replace(/\b(?:episode|epi|ep)[\s._-]*\d{1,3}\b/i, " ")
    .replace(/^[\s._-]*\d{1,3}(v\d)?\b/, " "));

  // What is left on a multi-language rip is often just the audio track list
  // ("Hindi English"), which is not an episode title.
  if (!s || naming.isOnlyNoise(s)) return "Episode " + episodeNo;
  return s;
}

// ---------------------------------------------------------------------------

function build(videos) {
  // 1. Annotate every file with its parsed signals.
  const files = videos.map(v => ({ ...v, sig: classifier.signals(v.path) }));

  // 2. Bucket by directory.
  const byDir = new Map();
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }

  // 3. Resolve a series name per directory, but only for directories that
  //    actually look like a run of episodes.
  const dirSeries = new Map();
  for (const [dir, group] of byDir) {
    const episodes = group.filter(f => f.sig.parsed.episode !== null);
    if (episodes.length < 2) continue;
    const resolved = resolveSeriesName(dir, episodes);
    if (resolved.name) dirSeries.set(dir, resolved);
  }

  const seriesByKey = new Map();
  const movies = [];

  for (const f of files) {
    const dir = path.dirname(f.path);
    const parsed = f.sig.parsed;
    const dirInfo = dirSeries.get(dir);

    // An Extras/Specials folder inherits its parent's series.
    let inherited = null;
    if (!dirInfo && isSpecialsFolder(dir)) {
      const parentInfo = dirSeries.get(path.dirname(dir));
      if (parentInfo) inherited = parentInfo;
    }

    const info = dirInfo || inherited;
    // Fall back to the file's own show guess for mixed folders (G:\RAW\ANIME).
    const seriesName = info ? info.name : parsed.showGuess;

    const isEpisode = parsed.episode !== null && !!seriesName &&
      !["Clips", "Home Videos", "Music Videos"].includes(classifier.categorise(f.path, f.sig));

    if (!isEpisode) {
      movies.push(f);
      continue;
    }

    const key = naming.showKey(seriesName);
    if (!seriesByKey.has(key)) {
      seriesByKey.set(key, { name: seriesName, files: [], showDir: null });
    }
    const bucket = seriesByKey.get(key);
    // Keep the longest spelling we have seen for this show.
    if (seriesName.length > bucket.name.length) bucket.name = seriesName;
    if (info && info.showDir && !bucket.showDir) bucket.showDir = info.showDir;

    let season = parsed.season;
    if (season === null && info) season = info.seasonHint;
    if (season === null && inherited) season = 0;      // Specials
    if (season === null) season = 1;
    if (isSpecialsFolder(dir)) season = 0;

    bucket.files.push({ file: f, season, episode: parsed.episode });
  }

  // 4. Score each series for anime, then let the shelf it sits on vote.
  //
  // Plenty of shows give nothing away on their own - "Attack On Titan Episode
  // 1 English Dubbed.mp4" could be any cartoon. But it sits in F:\ alongside
  // thirty shows that are unmistakably fansubbed anime, and a folder of shows
  // is almost never half anime and half not. So: if most of the series sharing
  // a parent folder are confidently anime, the quiet ones are too.
  const seriesList = [];
  for (const [key, bucket] of seriesByKey) {
    if (bucket.files.length < 2) {
      // A "series" of one episode is really just a loose file.
      movies.push(bucket.files[0].file);
      continue;
    }
    seriesList.push({
      key,
      bucket,
      score: Math.max(...bucket.files.map(e => e.file.sig.anime)),
      root: bucket.showDir ? path.dirname(bucket.showDir) : null
    });
  }

  const rootVote = new Map();
  for (const s of seriesList) {
    if (!s.root) continue;
    const v = rootVote.get(s.root) || { strong: 0, total: 0 };
    v.total++;
    if (s.score >= 3) v.strong++;
    rootVote.set(s.root, v);
  }
  const animeRoots = new Set(
    [...rootVote.entries()]
      .filter(([, v]) => v.total >= 3 && v.strong / v.total >= 0.5)
      .map(([root]) => root)
  );

  // 5. Emit titles.
  const titles = [];

  for (const { bucket, key, score, root } of seriesList) {
    const cats = bucket.files.map(e => classifier.categorise(e.file.path, e.file.sig));
    const isAnime = score >= 3 || (root && animeRoots.has(root));

    // "TV Shows" is what anything episodic falls back to, so a plain majority
    // vote lets it swamp a more specific answer: a lecture series where only
    // some filenames carry the "_6_min" marker would come out as a TV show.
    // A specific category only needs a solid minority to win.
    const SPECIFIC = ["Tutorials", "Music Videos", "Home Videos", "Clips"];
    const specific = SPECIFIC.find(c =>
      cats.filter(x => x === c).length >= Math.max(1, Math.ceil(cats.length / 3)));

    let category = isAnime ? "Anime" : (specific || mode(cats) || "TV Shows");
    if (category === "Movies" || category === "Other") category = "TV Shows";

    const seasonMap = new Map();
    for (const e of bucket.files) {
      if (!seasonMap.has(e.season)) seasonMap.set(e.season, []);
      seasonMap.get(e.season).push({
        id: e.file.id,
        episode: e.episode,
        title: episodeTitle(e.file.path, bucket.name, e.episode),
        size: e.file.size,
        mtime: e.file.mtime
      });
    }

    const seasons = [...seasonMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([number, eps]) => ({
        season: number,
        name: number === 0 ? "Specials" : "Season " + number,
        episodes: dedupeEpisodes(eps)
          .sort((a, b) => a.episode - b.episode || (a.id < b.id ? -1 : 1))
      }));

    const all = seasons.flatMap(s => s.episodes);
    titles.push({
      id: "s-" + hashId(key),
      type: "series",
      title: bucket.name,
      sortTitle: sortKey(bucket.name),
      category,
      year: null,
      episodeCount: all.length,
      seasonCount: seasons.length,
      poster: all[0] ? all[0].id : null,
      mtime: Math.max(...bucket.files.map(e => e.file.mtime || 0)),
      size: bucket.files.reduce((n, e) => n + (e.file.size || 0), 0),
      seasons
    });
  }

  const MOVIE_SIZE = 300 * 1024 * 1024;

  for (const f of movies) {
    let category = classifier.categorise(f.path, f.sig);
    // Most films on disk have no year in the filename, which is the only thing
    // that marked them as movies. A loose file this big, that nothing else
    // claimed, is a film rather than a stray clip.
    if (category === "Other" && (f.size || 0) >= MOVIE_SIZE) category = "Movies";
    const title = naming.prettyTitle(f.path);
    titles.push({
      id: "m-" + f.id,
      type: "movie",
      title,
      sortTitle: sortKey(title),
      // A lone file that parsed as an episode has no series to belong to.
      category: category === "TV Shows" || category === "Anime" ? "Other" : category,
      year: f.sig.year,
      episodeCount: 1,
      seasonCount: 0,
      poster: f.id,
      videoId: f.id,
      mtime: f.mtime,
      size: f.size,
      seasons: []
    });
  }

  // 6. Fold categories the user has switched off into "Other", so nothing
  //    disappears just because it has no row of its own.
  const enabled = (config && config.CATEGORIES) || {};
  for (const t of titles) {
    if (enabled[t.category] === false) t.category = "Other";
    else if (!(t.category in enabled)) t.category = "Other";
  }

  // Ordinal rather than localeCompare, so the shelf order does not shift with
  // the machine's locale, and with an id tiebreak so identically-named titles
  // keep a fixed order.
  titles.sort((a, b) =>
    (a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return titles;
}

// Two rips of the same episode in one folder: keep the bigger file.
// Two rips of the same episode in one folder: keep the bigger file, and when
// they are the same size keep whichever sorts first by id, so the choice is
// stable across scans instead of depending on directory order.
function dedupeEpisodes(eps) {
  const byNo = new Map();
  for (const e of eps) {
    const prev = byNo.get(e.episode);
    if (!prev) { byNo.set(e.episode, e); continue; }
    const bigger = (e.size || 0) - (prev.size || 0);
    if (bigger > 0 || (bigger === 0 && e.id < prev.id)) byNo.set(e.episode, e);
  }
  return [...byNo.values()];
}

// Most common value, ties broken alphabetically rather than by whichever key
// the Map happened to see first.
function mode(arr) {
  const counts = new Map();
  for (const a of arr) counts.set(a, (counts.get(a) || 0) + 1);
  let best = null, n = 0;
  for (const [k, c] of [...counts.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (c > n) { best = k; n = c; }
  }
  return best;
}

function sortKey(title) {
  return String(title).toLowerCase().replace(/^(the|a|an)\s+/, "");
}

module.exports = { build, episodeTitle, resolveSeriesName, climbToShowFolder };
