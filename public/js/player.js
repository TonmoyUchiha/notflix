// Notflix player: custom controls built for phones first.
// Handles direct streaming, converted (HLS) playback, and subtitles.

(() => {
  const $ = id => document.getElementById(id);

  const screen = $("player-screen");
  const video = $("player-video");
  const stage = $("player-stage");
  const titleEl = $("player-title");
  const closeBtn = $("close-player");
  const controls = $("player-controls");
  const statusEl = $("player-status");
  const spinner = $("player-spinner");
  const errorEl = $("player-error");

  const playBtn = $("ctl-play");
  const bigPlayBtn = $("big-play");
  const back10 = $("ctl-back10");
  const fwd10 = $("ctl-fwd10");
  const seekBar = $("seek-bar");
  const seekFill = $("seek-fill");
  const seekBuffer = $("seek-buffer");
  const seekKnob = $("seek-knob");
  const curTime = $("cur-time");
  const durTime = $("dur-time");
  const fsBtn = $("ctl-fullscreen");
  const speedBtn = $("ctl-speed");
  const volWrap = $("vol-wrap");
  const volRange = $("vol-range");
  const seekFeedback = $("seek-feedback");

  const subsBtn = $("ctl-subs");
  const subsSheet = $("subs-sheet");
  const subsList = $("subs-list");
  const subsNote = $("subs-note");

  const nextUp = $("next-up");
  const nextUpTitle = $("next-up-title");
  const nextUpBtn = $("next-up-btn");

  let hls = null;
  // Bumped on every open(). open() awaits /api/playinfo before touching the
  // video element, so a slow request could finish AFTER you had already backed
  // out and started something else - and then quietly apply the old video's
  // source and subtitle tracks over the new one. That is the stale subtitle
  // line hanging over a running episode. Each call keeps its own token and
  // bails if a newer open() has started since.
  let openToken = 0;
  let currentId = null;
  let currentInfo = null;
  let hideTimer = null;
  let scrubbing = false;
  let callbacks = {};
  let activeSubId = null;

  // Seconds the skip buttons, double-tap and arrow keys jump. One constant
  // so the buttons' labels and every jump site can never drift apart.
  const SEEK_STEP = 5;

  const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
  let speedIndex = 1;

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  // ---------- Controls visibility ----------
  function setControlsVisible(on) {
    controls.classList.toggle("visible", on);
    stage.classList.toggle("controls-visible", on);
  }

  // How long the controls stay up after you reveal them. Touch gets noticeably
  // longer than mouse: on a phone every action is reveal-then-aim-then-tap,
  // and the old 3.2s ran out mid-reach - especially for the small targets
  // (the back button, or grabbing the seek bar handle). A mouse pointer moves
  // and re-triggers this constantly, so it does not need the same slack.
  const HIDE_DELAY_TOUCH = 6000;
  const HIDE_DELAY_MOUSE = 3200;
  const isTouch = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const HIDE_DELAY = isTouch ? HIDE_DELAY_TOUCH : HIDE_DELAY_MOUSE;

  function showControls() {
    setControlsVisible(true);
    clearTimeout(hideTimer);
    if (!video.paused && subsSheet.classList.contains("hidden")) {
      hideTimer = setTimeout(() => setControlsVisible(false), HIDE_DELAY);
    }
  }
  function toggleControls() {
    setControlsVisible(!controls.classList.contains("visible"));
    if (controls.classList.contains("visible")) showControls();
  }

  // ---------- Status / spinner / errors ----------
  function setStatus(text) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("visible", !!text);
  }
  function setSpinner(on) { spinner.classList.toggle("visible", !!on); }
  function showError(msg) {
    setSpinner(false);
    setStatus("");
    errorEl.textContent = msg;
    errorEl.classList.add("visible");
  }
  function clearError() { errorEl.classList.remove("visible"); }

  // ---------- Subtitles ----------
  //
  // Every track is served as WebVTT and attached as a <track> element, which is
  // the one mechanism that works across all three playback paths: direct MP4,
  // hls.js on desktop, and iOS handing HLS to its own native player.

  function clearTracks() {
    // Disable every track BEFORE detaching its element. Removing a <track>
    // whose mode is still "showing" leaves its last cue painted: the element
    // is gone, but the rendered cue box is never repainted away, so a single
    // line of the previous video's subtitles hangs over the next one. Setting
    // mode to "disabled" is what actually takes a cue off the screen.
    //
    // The TextTrack objects also outlive their elements in some browsers, so
    // they are disabled through video.textTracks rather than via the elements.
    for (const t of video.textTracks) {
      t.removeEventListener("cuechange", positionCues);
      t.mode = "disabled";
    }
    [...video.querySelectorAll("track")].forEach(t => t.remove());
    activeSubId = null;
  }

  function attachTracks(subs) {
    clearTracks();
    subs.forEach(s => {
      const el = document.createElement("track");
      el.kind = "subtitles";
      el.label = s.label;
      if (s.lang) el.srclang = s.lang;
      el.src = s.url;
      el.dataset.subId = s.id;
      video.appendChild(el);
    });
    // Text tracks start disabled; nothing shows until one is switched on.
    for (const t of video.textTracks) t.mode = "disabled";
  }

  // A <video> is letterboxed: the element box is 16:9-agnostic, so the browser
  // lays cues out against the bottom of the *element*, which on a phone-shaped
  // viewport is well below the picture and right on top of the controls.
  // Repositioning each cue as a percentage of the box puts the text back
  // inside the frame where it belongs.
  function positionCues() {
    const track = [...video.textTracks].find(t => t.mode === "showing");
    if (!track || !track.cues || !track.cues.length) return;

    const boxH = video.clientHeight;
    const boxW = video.clientWidth;
    let line = 88; // sensible default before dimensions are known

    if (boxH && boxW && video.videoWidth && video.videoHeight) {
      const pictureH = Math.min(boxH, boxW * video.videoHeight / video.videoWidth);
      const bottomOfPicture = (1 - (boxH - pictureH) / 2 / boxH) * 100;
      // Sit one tenth of the *picture* above its bottom edge. Measuring the
      // inset against the picture rather than the box keeps subtitles in the
      // same place whether the video is letterboxed or fills the screen.
      const inset = (pictureH / boxH) * 100 * 0.1;
      line = Math.max(50, Math.min(94, bottomOfPicture - inset));
    }

    for (const cue of track.cues) {
      cue.snapToLines = false;
      cue.line = line;
      cue.align = "center";
    }
  }

  // Cues arrive asynchronously after the track file loads, so this runs again
  // on the first few cue changes rather than only once.
  function watchCues() {
    for (const t of video.textTracks) {
      if (t.mode !== "showing") continue;
      t.removeEventListener("cuechange", positionCues);
      t.addEventListener("cuechange", positionCues);
    }
    positionCues();
  }

  window.addEventListener("resize", positionCues);
  document.addEventListener("fullscreenchange", positionCues);
  document.addEventListener("webkitfullscreenchange", positionCues);
  video.addEventListener("loadedmetadata", () => setTimeout(positionCues, 60));

  function selectSubtitle(id) {
    activeSubId = id;
    const nodes = [...video.querySelectorAll("track")];
    nodes.forEach((node, i) => {
      const track = video.textTracks[i];
      if (!track) return;
      track.mode = (node.dataset.subId === id) ? "showing" : "disabled";
    });
    subsBtn.classList.toggle("active", !!id);

    // The track file may still be downloading; re-run once its cues exist.
    watchCues();
    setTimeout(watchCues, 300);
    setTimeout(watchCues, 1200);

    // Remember the language, not the track: the next episode is a different
    // file with different track ids but usually the same languages.
    if (id) {
      const chosen = (currentInfo.subtitles || []).find(s => s.id === id);
      window.NotflixSubPref.set(chosen ? chosen.lang || chosen.label : null);
    } else {
      window.NotflixSubPref.set(null);
    }
    renderSubsSheet();
  }

  // Which track should come on by itself: whatever you last chose, else the
  // file's own default, else the configured language.
  function pickDefaultSubtitle(info) {
    const subs = info.subtitles || [];
    if (!subs.length) return null;

    const pref = window.NotflixSubPref.get();
    if (pref === null) {
      // Never chosen anything - fall through to the file/config default.
    } else if (pref === "" || pref === "off") {
      return null;
    } else {
      const byPref = subs.find(s => s.lang === pref) || subs.find(s => s.label === pref);
      if (byPref) return byPref.id;
    }

    const flagged = subs.find(s => s.default);
    if (flagged) return flagged.id;

    const lang = info.defaultSubtitleLanguage;
    if (lang) {
      const byLang = subs.find(s => s.lang === lang);
      if (byLang) return byLang.id;
    }
    return null;
  }

  function renderSubsSheet() {
    const subs = (currentInfo && currentInfo.subtitles) || [];
    const burn = (currentInfo && currentInfo.burnInSubtitles) || [];
    subsList.innerHTML = "";

    const rows = [{ id: null, label: "Off" }].concat(subs);
    rows.forEach(s => {
      const b = document.createElement("button");
      b.className = "sheet-item" + (activeSubId === s.id ? " active" : "");
      const check = document.createElement("span");
      check.className = "sheet-check";
      check.textContent = activeSubId === s.id ? "✓" : "";
      const label = document.createElement("span");
      label.textContent = s.label;
      b.appendChild(check);
      b.appendChild(label);
      b.onclick = () => { selectSubtitle(s.id); closeSubsSheet(); };
      subsList.appendChild(b);
    });

    if (burn.length) {
      subsNote.textContent = burn.length === 1
        ? "1 image-based track (" + burn[0].label + ") can't be shown as text. It would have to be drawn into the picture."
        : burn.length + " image-based tracks can't be shown as text.";
      subsNote.classList.remove("hidden");
    } else {
      subsNote.classList.add("hidden");
    }
  }

  function openSubsSheet() {
    renderSubsSheet();
    subsSheet.classList.remove("hidden");
    setControlsVisible(true);
    clearTimeout(hideTimer);
  }
  function closeSubsSheet() {
    subsSheet.classList.add("hidden");
    showControls();
  }

  subsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (subsSheet.classList.contains("hidden")) openSubsSheet();
    else closeSubsSheet();
  });
  subsSheet.addEventListener("click", (e) => {
    if (e.target === subsSheet) closeSubsSheet();
  });

  // ---------- Loading a video ----------
  async function open(id, title, opts) {
    const myToken = ++openToken;
    currentId = id;
    callbacks = opts || {};
    titleEl.textContent = title || "";
    clearError();
    clearTracks();
    hideNextUp();
    setSpinner(true);
    setStatus("Loading");
    screen.classList.remove("hidden");
    showControls();
    teardownHls();

    let info;
    try {
      const res = await fetch("/api/playinfo/" + id);
      info = await res.json();
      // Superseded while this was in flight - the user has already opened
      // something else. Everything below writes to the shared video element,
      // so this call must stop here rather than clobber the newer one.
      if (myToken !== openToken) return;
      if (!res.ok) return showError(info.error || "This video couldn't be opened.");
    } catch (_) {
      if (myToken !== openToken) return;
      return showError("Lost connection to your PC. Check that Notflix is still running.");
    }
    currentInfo = info;

    const hasSubs = (info.subtitles || []).length > 0 || (info.burnInSubtitles || []).length > 0;
    subsBtn.classList.toggle("hidden", !hasSubs);
    subsBtn.classList.remove("active");

    if (info.mode === "direct") {
      setStatus("");
      video.src = info.url;
      afterSourceSet(info);
      return;
    }

    // Converted playback.
    //
    // hls.js is tried first, not second. Chrome answers "maybe" to
    // canPlayType("application/vnd.apple.mpegurl") without actually being able
    // to play a playlist, so trusting that answer sends desktop browsers down
    // the native path and playback dies on the first segment. iPhones have no
    // MSE, so Hls.isSupported() is false there and they still get the native
    // player, which is the one place it genuinely works.
    setStatus(info.reason || "Preparing video");

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        maxBufferLength: 30,
        manifestLoadingTimeOut: 20000,
        fragLoadingTimeOut: 60000 // segments are transcoded on request, allow time
      });
      hls.loadSource(info.url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (evt, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else showError("Playback failed while converting this video.");
      });
      afterSourceSet(info);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = info.url;
      afterSourceSet(info);
    } else {
      showError("This browser can't play converted video.");
    }
  }

  function afterSourceSet(info) {
    // Tracks are attached after the source so the element is not rebuilt
    // underneath them.
    attachTracks(info.subtitles || []);
    const wanted = pickDefaultSubtitle(info);
    if (wanted) {
      // Give the browser a tick to register the <track> elements it just got.
      setTimeout(() => selectSubtitle(wanted), 0);
    } else {
      subsBtn.classList.remove("active");
    }

    const resumeMap = window.NotflixResume ? window.NotflixResume.get() : {};
    const saved = resumeMap[currentId];

    video.onloadedmetadata = () => {
      const dur = isFinite(video.duration) && video.duration > 0
        ? video.duration
        : (info.duration || 0);
      durTime.textContent = fmt(dur);
      if (saved && saved.time && saved.time < dur - 20) {
        try { video.currentTime = saved.time; } catch (_) {}
      }
      video.play().catch(() => {
        // Autoplay blocked. The big play button is already on screen.
        setSpinner(false);
        setStatus("");
      });
    };
  }

  function teardownHls() {
    if (hls) {
      try { hls.destroy(); } catch (_) {}
      hls = null;
    }
  }

  function close() {
    saveProgress(true);
    video.pause();
    teardownHls();
    clearTracks();
    hideNextUp();
    closeSubsSheet();
    subsSheet.classList.add("hidden");
    video.removeAttribute("src");
    video.load();
    screen.classList.add("hidden");
    clearError();
    setSpinner(false);
    setStatus("");
    if (callbacks.onClose) callbacks.onClose();
  }

  // `immediate` forces the position up to the PC right away instead of waiting
  // for the next batched push - used when you pause, close or finish, which
  // are exactly the moments you might walk over to the other device.
  function saveProgress(immediate) {
    if (!currentId || !video.duration || !window.NotflixResume) return;
    window.NotflixResume.set(currentId, video.currentTime, video.duration);
    if (immediate) window.NotflixResume.flush();
  }

  // ---------- Next episode ----------
  function showNextUp() {
    if (!currentInfo || !currentInfo.next) return;
    nextUpTitle.textContent = currentInfo.next.label;
    nextUp.classList.add("visible");
  }
  function hideNextUp() { nextUp.classList.remove("visible"); }

  function playNext() {
    if (!currentInfo || !currentInfo.next) return;
    const next = currentInfo.next;
    saveProgress(true);
    teardownHls();
    open(next.id, next.title, callbacks);
  }
  nextUpBtn.addEventListener("click", playNext);

  // ---------- Playback controls ----------
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showControls();
  }

  function skip(seconds) {
    const target = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
    video.currentTime = target;
    flashSeek(seconds);
    showControls();
  }

  function flashSeek(seconds) {
    seekFeedback.textContent = (seconds > 0 ? "+" : "") + seconds + "s";
    seekFeedback.classList.add("visible");
    clearTimeout(flashSeek._t);
    flashSeek._t = setTimeout(() => seekFeedback.classList.remove("visible"), 600);
  }

  playBtn.addEventListener("click", togglePlay);
  bigPlayBtn.addEventListener("click", togglePlay);
  back10.textContent = "↺" + SEEK_STEP;
  fwd10.textContent = SEEK_STEP + "↻";
  back10.title = "Back " + SEEK_STEP + " seconds";
  fwd10.title = "Forward " + SEEK_STEP + " seconds";
  back10.addEventListener("click", () => skip(-SEEK_STEP));
  fwd10.addEventListener("click", () => skip(SEEK_STEP));
  closeBtn.addEventListener("click", close);

  video.addEventListener("play", () => {
    playBtn.textContent = "❚❚";
    bigPlayBtn.classList.add("hidden");
    showControls();
  });
  video.addEventListener("pause", () => {
    playBtn.textContent = "▶";
    bigPlayBtn.classList.remove("hidden");
    setControlsVisible(true);
    clearTimeout(hideTimer);
    saveProgress(true);
  });
  video.addEventListener("waiting", () => setSpinner(true));
  video.addEventListener("playing", () => { setSpinner(false); setStatus(""); clearError(); });
  video.addEventListener("canplay", () => setSpinner(false));
  video.addEventListener("ended", () => {
    saveProgress(true);
    setControlsVisible(true);
    if (currentInfo && currentInfo.next) playNext();
  });

  video.addEventListener("error", () => {
    showError("This video couldn't be played. It may be an unsupported or damaged file.");
  });

  // ---------- Progress + seeking ----------
  video.addEventListener("timeupdate", () => {
    if (scrubbing) return;
    const dur = video.duration || 0;
    const pct = dur ? (video.currentTime / dur) * 100 : 0;
    seekFill.style.width = pct + "%";
    seekKnob.style.left = pct + "%";
    curTime.textContent = fmt(video.currentTime);
    if (dur) durTime.textContent = fmt(dur);
    if (Math.floor(video.currentTime) % 5 === 0) saveProgress();

    // Offer the next episode over the closing credits.
    if (dur && currentInfo && currentInfo.next) {
      if (dur - video.currentTime <= 45) showNextUp();
      else hideNextUp();
    }
  });

  video.addEventListener("progress", () => {
    if (!video.buffered.length || !video.duration) return;
    const end = video.buffered.end(video.buffered.length - 1);
    seekBuffer.style.width = Math.min(100, (end / video.duration) * 100) + "%";
  });

  function seekFromEvent(e) {
    const rect = seekBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = video.duration || 0;
    seekFill.style.width = ratio * 100 + "%";
    seekKnob.style.left = ratio * 100 + "%";
    curTime.textContent = fmt(ratio * dur);
    return ratio * dur;
  }

  function startScrub(e) {
    scrubbing = true;
    seekFromEvent(e);
    showControls();
    e.preventDefault();
  }
  function moveScrub(e) {
    if (!scrubbing) return;
    seekFromEvent(e);
    e.preventDefault();
  }
  function endScrub(e) {
    if (!scrubbing) return;
    const t = seekFromEvent(e.changedTouches ? { touches: e.changedTouches } : e);
    if (isFinite(t)) video.currentTime = t;
    scrubbing = false;
    showControls();
  }

  seekBar.addEventListener("mousedown", startScrub);
  window.addEventListener("mousemove", moveScrub);
  window.addEventListener("mouseup", endScrub);
  seekBar.addEventListener("touchstart", startScrub, { passive: false });
  seekBar.addEventListener("touchmove", moveScrub, { passive: false });
  seekBar.addEventListener("touchend", endScrub);

  // ---------- Tap and double-tap on the video ----------
  let lastTap = 0;
  stage.addEventListener("click", (e) => {
    if (e.target.closest("#player-controls") ||
        e.target.closest("#big-play") ||
        e.target.closest("#subs-sheet") ||
        e.target.closest("#next-up")) return;

    if (!subsSheet.classList.contains("hidden")) { closeSubsSheet(); return; }

    const now = Date.now();
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (now - lastTap < 300) {
      // Double tap: seek back on the left third, forward on the right third.
      if (x < rect.width * 0.35) skip(-SEEK_STEP);
      else if (x > rect.width * 0.65) skip(SEEK_STEP);
      else togglePlay();
      lastTap = 0;
    } else {
      lastTap = now;
      setTimeout(() => {
        if (lastTap !== 0 && Date.now() - lastTap >= 300) {
          toggleControls();
          lastTap = 0;
        }
      }, 300);
    }
  });

  // ---------- Fullscreen ----------
  fsBtn.addEventListener("click", () => {
    const el = screen;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone fallback
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    showControls();
  });

  // ---------- Speed ----------
  speedBtn.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIndex];
    speedBtn.textContent = SPEEDS[speedIndex] + "x";
    showControls();
  });

  // ---------- Volume (desktop only; iOS ignores volume changes) ----------
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    volWrap.classList.remove("hidden");
    volRange.addEventListener("input", () => {
      video.volume = parseFloat(volRange.value);
    });
  }

  // ---------- Keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (screen.classList.contains("hidden")) return;
    switch (e.key) {
      case " ": case "k": e.preventDefault(); togglePlay(); break;
      case "ArrowLeft": skip(-SEEK_STEP); break;
      case "ArrowRight": skip(SEEK_STEP); break;
      case "ArrowUp": video.volume = Math.min(1, video.volume + 0.1); break;
      case "ArrowDown": video.volume = Math.max(0, video.volume - 0.1); break;
      case "f": fsBtn.click(); break;
      case "m": video.muted = !video.muted; break;
      case "c": if (!subsBtn.classList.contains("hidden")) subsBtn.click(); break;
      case "n": playNext(); break;
      case "Escape":
        if (!subsSheet.classList.contains("hidden")) closeSubsSheet();
        else close();
        break;
    }
  });

  // Mouse movement on desktop reveals controls.
  stage.addEventListener("mousemove", showControls);

  window.NotflixPlayer = { open, close };
})();
