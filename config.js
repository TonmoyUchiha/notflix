// ============================================================
//  NOTFLIX CONFIG
//  Edit this file to control how Notflix behaves.
//  After changing anything here, restart the server.
// ============================================================

module.exports = {
  // ---- Access ----
  // 4-digit PIN required to open Notflix on any device.
  PIN: "1234",

  // Port the server runs on. http://<your-pc-ip>:PORT
  PORT: 7777,

  // ---- A fixed address for your phone ----
  // Your router usually hands your PC a different IP every so often, which
  // breaks a Notflix icon saved to your phone's home screen - it remembers the
  // exact address it was added from.
  //
  // So Notflix also answers to a name on your home network. Add the app to
  // your phone using:
  //
  //     http://notflix.local:7777
  //
  // and it keeps working no matter what IP your PC ends up with. Nothing to
  // set up on the router. Works on iPhone out of the box, and on Android 12+.
  //
  // Change the name here if you like (the ".local" part is added for you).
  HOSTNAME: "notflix",

  // Set to false to switch the name off and use the IP address only.
  MDNS_ENABLED: true,

  // How long a login stays valid before asking for the PIN again (hours)
  SESSION_HOURS: 24 * 14, // 2 weeks

  // ---- Library scanning ----
  // Leave empty to auto-scan every local drive found on the PC (C:, D:, ...).
  // Or list specific folders to restrict scanning, e.g.:
  // SCAN_ROOTS: ["C:\\Users\\Tonmoy\\Videos", "D:\\Movies"]
  SCAN_ROOTS: [],

  // Folder names to always skip (case-insensitive), anywhere in the tree.
  // Add your own if the scan picks up folders you don't care about.
  EXCLUDE_DIR_NAMES: [
    "windows", "program files", "program files (x86)", "programdata",
    "$recycle.bin", "system volume information", "node_modules",
    "appdata", "recovery", "msocache", "perflogs", "intel", "nvidia",
    ".git", ".cache", "temp", "tmp", "$windows.~bt", "$windows.~ws",
    "windows.old"
  ],

  // Any folder whose name starts with a dot is always treated as hidden
  // and skipped (covers .git, .cache, etc. on top of the list above).

  // Video file extensions Notflix will pick up.
  // ".ts" is both "MPEG transport stream" and "TypeScript". Notflix checks the
  // file's contents before accepting one, so source code never gets in.
  VIDEO_EXTENSIONS: [
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv",
    ".webm", ".m4v", ".mpg", ".mpeg", ".ts", ".m2ts"
  ],

  // Skip files smaller than this (bytes) - filters out junk/broken clips.
  MIN_FILE_SIZE_BYTES: 2 * 1024 * 1024, // 2MB

  // ---- What counts as a video worth showing ----
  // Videos that ship inside games - menu loops, splash screens, cutscenes,
  // visual-novel scene files - are found by fingerprinting the folder they
  // live in (a .exe next to a Unity/Unreal/Ren'Py layout) as well as by path.
  // Turn this off to let them back in.
  EXCLUDE_GAME_VIDEOS: true,

  // Same idea for source-code checkouts: a folder with a package.json or a
  // .sln in it is a project, and its videos are assets, not entertainment.
  EXCLUDE_CODE_PROJECTS: true,

  // Skip anything marked Hidden or System in Windows, including everything
  // inside a hidden folder. Windows stores this as a file attribute rather
  // than a leading dot, so it is invisible to an ordinary directory listing -
  // without this check, a folder you hid in Explorer still shows up here.
  EXCLUDE_HIDDEN: true,

  // Folders (or single files) to keep out of the library no matter what.
  // Everything underneath a listed folder is excluded too. For example:
  // EXCLUDE_PATHS: ["G:\\Private", "D:\\Downloading\\unsorted"]
  EXCLUDE_PATHS: [],

  // ---- Categories ----
  // Rows on the home screen, in this order. Anything Notflix classifies into a
  // category that is switched off here lands in "Other" instead, so nothing is
  // ever lost - flip one to true to give it its own row.
  CATEGORIES: {
    "Movies": true,
    "TV Shows": true,
    "Anime": true,
    "Clips": true,          // your own gameplay / screen captures
    "Home Videos": false,   // phone footage, DCIM, camera recordings
    "Tutorials": false,     // courses and lessons
    "Music Videos": false,
    "Other": true           // the catch-all; keep this on
  },

  // ---- Subtitles ----
  SUBTITLES_ENABLED: true,

  // Subtitles embedded in the file and files sitting next to it (.srt, .ass,
  // Subs\ folders) are both offered. They are converted to WebVTT on demand,
  // which keeps timing and text but drops ASS styling - the trade for being
  // able to switch them on and off instantly.

  // Turn a subtitle track on automatically when one matches this language.
  // Use null to always start with subtitles off.
  SUBTITLE_DEFAULT_LANGUAGE: "en",

  // ---- Thumbnails ----
  THUMBNAIL_ENABLED: true,
  // Where in the video to grab the thumbnail frame (% of duration).
  THUMBNAIL_POSITION_PERCENT: 15,
  // How many thumbnails to generate at once during background pass.
  THUMBNAIL_CONCURRENCY: 2,

  // ---- Playback / transcoding ----
  // iPhones (and Chrome on iPhone, which is really Safari underneath) can only
  // play H.264 video with AAC audio in an MP4 container. Anything else - most
  // MKV files, AVI, older codecs - has to be converted on the fly.
  //
  // Notflix does this in short chunks so playback starts within a couple of
  // seconds instead of waiting for a whole file to convert. Files that are
  // already iPhone-friendly skip conversion entirely and stream directly.

  // Length of each transcoded chunk, in seconds. Shorter = faster startup but
  // more ffmpeg calls. 6 is a good balance.
  SEGMENT_SECONDS: 6,

  // x264 speed/quality tradeoff. Options, fastest to slowest:
  // ultrafast, superfast, veryfast, faster, fast, medium
  // If playback stutters on a slower PC, move toward ultrafast.
  TRANSCODE_PRESET: "veryfast",

  // Quality. Lower = better looking + bigger. 18 is near-lossless, 28 is rough.
  TRANSCODE_CRF: 21,

  // Cap resolution when converting. 720 is plenty on a phone screen and much
  // lighter on your CPU. Raise to 1080 if you also watch on a big screen.
  TRANSCODE_MAX_HEIGHT: 720,

  // Delete cached converted chunks older than this many days. Set to 0 to keep
  // them forever.
  HLS_CACHE_DAYS: 14,

  // ---- Storage ----
  // Where scan results & thumbnails are cached (relative to this folder).
  DATA_DIR: "./data",
  THUMBNAIL_DIR: "./public/cache/thumbnails"
};
