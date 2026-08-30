(() => {
  const $ = id => document.getElementById(id);

  const loginScreen = $("login-screen");
  const browseScreen = $("browse-screen");
  const pinDots = $("pin-dots");
  const pinError = $("pin-error");
  const keypad = document.querySelector(".keypad");

  const navbar = $("navbar");
  const navTabs = $("nav-tabs");
  const rowsEl = $("rows");
  const heroEl = $("hero");
  const heroBackdrop = $("hero-backdrop");
  const heroTitle = $("hero-title");
  const heroMeta = $("hero-meta");
  const heroPlay = $("hero-play");
  const heroInfo = $("hero-info");
  const scanBanner = $("scan-banner");
  const emptyState = $("empty-state");
  const rescanBtn = $("rescan-btn");

  const searchBtn = $("search-btn");
  const searchPanel = $("search-panel");
  const searchInput = $("search-input");
  const searchClose = $("search-close");
  const searchResults = $("search-results");
  const searchEmpty = $("search-empty");

  const detail = $("detail");
  const detailBackdrop = $("detail-backdrop");
  const detailTitle = $("detail-title");
  const detailMeta = $("detail-meta");
  const detailPlay = $("detail-play");
  const detailClose = $("detail-close");
  const seasonPicker = $("season-picker");
  const seasonSelect = $("season-select");
  const episodeList = $("episode-list");
  const detailList = $("detail-list");
  const detailListText = $("detail-list-text");
  const detailPath = $("detail-path");
  const detailPathValue = $("detail-path-value");
  const detailPathCopied = $("detail-path-copied");

  let pin = "";
  let library = null;
  let activeTab = "All";
  let openTitle = null;

  // ---------------- Resume tracking (shared with the player) ----------------
  //
  // The PC holds the real record, so where you stopped on one device is where
  // you carry on from on another. localStorage is kept as a mirror: it makes
  // the first paint instant, and it holds anything recorded while the server
  // was unreachable so it can be handed over on the next connection.
  const RESUME_KEY = "notflix_resume";
  const PUSH_INTERVAL_MS = 5000;

  const Resume = {
    cache: readLocal(),
    pending: new Map(),   // id -> {time, duration}
    lastPush: 0,
    timer: null,

    get() { return Resume.cache; },

    set(id, time, duration) {
      if (!id || !isFinite(time)) return;
      // Mirror the server's own rules so the row updates before the round trip.
      if (duration && time > duration - 20) delete Resume.cache[id];
      else if (time < 15) delete Resume.cache[id];
      else Resume.cache[id] = { time, duration, at: Date.now() };

      writeLocal();
      Resume.pending.set(id, { time, duration });
      Resume.schedule();
    },

    // Positions are sent at most every few seconds while something plays;
    // pausing, closing or finishing flushes straight away.
    schedule() {
      if (Resume.timer) return;
      const wait = Math.max(0, PUSH_INTERVAL_MS - (Date.now() - Resume.lastPush));
      Resume.timer = setTimeout(() => {
        Resume.timer = null;
        Resume.push();
      }, wait);
    },

    push() {
      if (!Resume.pending.size) return;
      const batch = [...Resume.pending.entries()];
      Resume.pending.clear();
      Resume.lastPush = Date.now();
      for (const [id, v] of batch) {
        fetch("/api/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, time: v.time, duration: v.duration })
        }).catch(() => {
          // Offline: keep it locally and hand it over on the next sync.
          Resume.pending.set(id, v);
        });
      }
    },

    flush() {
      clearTimeout(Resume.timer);
      Resume.timer = null;
      Resume.push();
    },

    // Called once on entry: take the server's map as the truth, then push up
    // anything this device recorded more recently than the server knows about.
    async sync() {
      try {
        const local = Resume.cache;
        const res = await fetch("/api/progress/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: local })
        });
        if (!res.ok) return;
        const data = await res.json();
        Resume.cache = data.entries || {};
        writeLocal();
      } catch (_) { /* stay on the local mirror until the server is back */ }
    }
  };

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "{}"); }
    catch (_) { return {}; }
  }
  function writeLocal() {
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(Resume.cache)); }
    catch (_) {}
  }

  // Closing the tab or locking the phone should not lose the last few seconds.
  window.addEventListener("pagehide", () => Resume.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") Resume.flush();
  });

  window.NotflixResume = Resume;

  // Subtitle choice is remembered per language, not per file, so picking
  // "English" once carries across every episode of a show.
  const SUB_KEY = "notflix_sub_lang";
  window.NotflixSubPref = {
    get() { try { return localStorage.getItem(SUB_KEY); } catch (_) { return null; } },
    set(lang) {
      try {
        if (lang) localStorage.setItem(SUB_KEY, lang);
        else localStorage.removeItem(SUB_KEY);
      } catch (_) {}
    }
  };

  // ---------------- PIN entry ----------------
  keypad.addEventListener("click", (e) => {
    const btn = e.target.closest(".key");
    if (!btn) return;
    const key = btn.dataset.key;
    if (key === "clear") { pin = ""; renderPinDots(); return; }
    if (key === "back") { pin = pin.slice(0, -1); renderPinDots(); return; }
    if (pin.length >= 4) return;
    pin += key;
    renderPinDots();
    if (pin.length === 4) submitPin();
  });

  function renderPinDots() {
    [...pinDots.children].forEach((dot, i) => {
      dot.classList.toggle("filled", i < pin.length);
    });
  }

  async function submitPin() {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    if (res.ok) {
      pinError.classList.remove("show");
      enterBrowse();
    } else {
      pinError.classList.add("show", "shake");
      setTimeout(() => pinError.classList.remove("shake"), 350);
      setTimeout(() => { pin = ""; renderPinDots(); }, 300);
    }
  }

  async function enterBrowse() {
    loginScreen.classList.add("hidden");
    browseScreen.classList.remove("hidden");
    // Reconcile with the PC before the first render, so Continue Watching
    // shows where you actually stopped rather than what this device remembers.
    await Resume.sync();
    loadLibrary();
    pollScanStatus();
  }

  // ---------------- Library ----------------
  async function loadLibrary() {
    const res = await fetch("/api/library");
    if (!res.ok) return;
    library = await res.json();
    render();
  }

  function render() {
    if (!library) return;
    const cats = library.categories || [];

    if (!library.total) {
      emptyState.classList.remove("hidden");
      heroEl.classList.add("hidden");
      rowsEl.innerHTML = "";
      navTabs.innerHTML = "";
      return;
    }
    emptyState.classList.add("hidden");

    List.sync(library.watchlist);
    renderTabs(cats);
    renderSidebar(cats);
    renderHero(cats);
    renderRows(cats);
  }

  function renderTabs(cats) {
    // My List earns a tab once there is something in it. On a phone the drawer
    // covers this, but on a wide screen the drawer is hidden and the tabs are
    // the only way to reach the full grid.
    const names = ["All"];
    if ((library.watchlist || []).length) names.push("My List");
    names.push(...cats.map(c => c.name));
    if (!names.includes(activeTab)) activeTab = "All";
    navTabs.innerHTML = "";
    names.forEach(name => {
      const b = document.createElement("button");
      b.className = "nav-tab" + (name === activeTab ? " active" : "");
      b.textContent = name;
      b.onclick = () => selectTab(name);
      navTabs.appendChild(b);
    });
  }

  // The featured title changes daily, and is picked from whatever has the most
  // to watch so the banner is never a stray one-off clip.
  function renderHero(cats) {
    const pool = cats
      .filter(c => ["Movies", "TV Shows", "Anime"].includes(c.name))
      .flatMap(c => c.items)
      .filter(t => t.hasThumbnail);
    const source = pool.length ? pool : cats.flatMap(c => c.items);
    if (!source.length) { heroEl.classList.add("hidden"); return; }

    const featured = source[dayIndex(source.length)];
    heroBackdrop.style.backgroundImage = featured.hasThumbnail
      ? `url(/api/thumb/${featured.poster})`
      : "none";
    heroTitle.textContent = featured.title;
    heroMeta.innerHTML = "";
    metaBits(featured).forEach(bit => heroMeta.appendChild(bit));
    heroPlay.onclick = () => playTitle(featured);
    heroInfo.onclick = () => openDetail(featured.id);
    heroEl.classList.remove("hidden");
  }

  function dayIndex(n) {
    const d = new Date();
    return (d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()) % n;
  }

  function metaBits(t) {
    const out = [];
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = t.category;
    out.push(pill);

    const text = document.createElement("span");
    if (t.type === "series") {
      const seasons = t.seasonCount === 1 ? "1 season" : t.seasonCount + " seasons";
      text.textContent = seasons + " · " + t.episodeCount + " episodes";
    } else if (t.year) {
      text.textContent = String(t.year);
    }
    if (text.textContent) out.push(text);
    return out;
  }

  function renderRows(cats) {
    rowsEl.innerHTML = "";
    const resumeMap = Resume.get();

    if (activeTab === "My List") {
      const items = library.watchlist || [];
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.innerHTML = "<h2>My List is empty</h2>" +
          "<p>Open anything and tap <strong>My List</strong> to keep it here.</p>";
        rowsEl.appendChild(empty);
        return;
      }
      renderRow("My List", items, resumeMap, items.length);
      return;
    }

    if (activeTab === "All") {
      const saved = library.watchlist || [];
      if (saved.length) renderRow("My List", saved, resumeMap, saved.length);
      const continueRow = library.continueWatching || [];
      if (continueRow.length) renderRow("Continue watching", continueRow, resumeMap);
      if (library.recent && library.recent.length) {
        renderRow("Recently added", library.recent, resumeMap);
      }
      cats.forEach(c => renderRow(c.name, c.items.slice(0, 40), resumeMap, c.count));
      return;
    }

    const cat = cats.find(c => c.name === activeTab);
    if (!cat) return;
    // Inside one category, break the long list into alphabetical shelves so it
    // stays scannable rather than being one 600-card strip.
    const chunks = alphaChunks(cat.items);
    chunks.forEach(([label, items]) => renderRow(label, items, resumeMap));
  }

  function alphaChunks(items) {
    if (items.length <= 24) return [["All " + items.length, items]];
    const groups = new Map();
    for (const t of items) {
      const c = (t.title[0] || "#").toUpperCase();
      const key = /[A-Z]/.test(c) ? c : "#";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function renderRow(title, items, resumeMap, totalCount) {
    if (!items.length) return;
    const row = document.createElement("div");
    row.className = "row";

    const head = document.createElement("div");
    head.className = "row-head";
    const heading = document.createElement("h3");
    heading.className = "row-title";
    heading.textContent = title;
    head.appendChild(heading);
    if (totalCount && totalCount > items.length) {
      const count = document.createElement("span");
      count.className = "row-count";
      count.textContent = "showing " + items.length + " of " + totalCount;
      head.appendChild(count);
    }

    const scroller = document.createElement("div");
    scroller.className = "row-scroller";
    items.forEach(t => scroller.appendChild(renderCard(t, resumeMap)));

    // The scroller sits in a track so the arrows can be positioned against
    // the cards themselves rather than the row's heading as well.
    const track = document.createElement("div");
    track.className = "row-track";
    const prev = document.createElement("button");
    prev.className = "row-nav row-nav-prev";
    prev.setAttribute("aria-label", "Scroll left");
    prev.innerHTML = "&#8249;";
    const next = document.createElement("button");
    next.className = "row-nav row-nav-next";
    next.setAttribute("aria-label", "Scroll right");
    next.innerHTML = "&#8250;";

    track.appendChild(prev);
    track.appendChild(scroller);
    track.appendChild(next);

    row.appendChild(head);
    row.appendChild(track);
    rowsEl.appendChild(row);

    wireRowScrolling(track, scroller, prev, next);
  }

  // Gives a mouse three ways through a horizontal row: the arrows at each
  // end, the wheel, and dragging. Touch already had swiping and is untouched.
  function wireRowScrolling(track, scroller, prev, next) {
    // Arrows only appear when there is actually something to scroll to, and
    // each one hides at the end it would take you past.
    function updateArrows() {
      const max = scroller.scrollWidth - scroller.clientWidth;
      const x = scroller.scrollLeft;
      // A row at rest does NOT sit at scrollLeft 0: scroll-snap lands the
      // first card against the scroller's own left padding, so "not scrolled"
      // is really scrollLeft === padding-left. Comparing against 0 made the
      // left arrow appear on every row from the start, pointing at nothing.
      const restLeft = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
      prev.classList.toggle("can-scroll", max > 4 && x > restLeft + 4);
      next.classList.toggle("can-scroll", max > 4 && x < max - 4);
    }

    function page(dir) {
      // Just under a full screenful, so a card stays visible as an anchor
      // and you never lose your place between pages.
      scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: "smooth" });
    }

    prev.addEventListener("click", () => page(-1));
    next.addEventListener("click", () => page(1));
    scroller.addEventListener("scroll", updateArrows, { passive: true });
    window.addEventListener("resize", updateArrows);
    // Card art loads late and changes scrollWidth, so re-check once it settles.
    setTimeout(updateArrows, 0);
    setTimeout(updateArrows, 600);

    // A plain mouse wheel only reports deltaY, so without this a wheel over a
    // row does nothing horizontal at all. Deliberately does NOT swallow the
    // page scroll at the ends of the row: once you have reached the last card,
    // carrying on scrolling should move the page, not sit there stuck.
    scroller.addEventListener("wheel", (e) => {
      if (e.ctrlKey) return;                    // pinch-zoom gesture
      const max = scroller.scrollWidth - scroller.clientWidth;
      if (max <= 4) return;                     // nothing to scroll
      // A trackpad's horizontal swipe already works; leave it alone.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      const dir = e.deltaY > 0 ? 1 : -1;
      const atEnd = (dir > 0 && scroller.scrollLeft >= max - 1) ||
                    (dir < 0 && scroller.scrollLeft <= 1);
      if (atEnd) return;                        // let the page take over

      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    }, { passive: false });

    // Click-and-drag, the way you would shove a shelf sideways.
    let down = false, startX = 0, startLeft = 0, moved = 0;

    scroller.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      down = true; moved = 0;
      startX = e.clientX;
      startLeft = scroller.scrollLeft;
    });

    scroller.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;   // tolerate a shaky click
      moved = Math.max(moved, Math.abs(dx));
      scroller.classList.add("dragging");
      scroller.scrollLeft = startLeft - dx;
      e.preventDefault();
    });

    function endDrag() {
      if (!down) return;
      down = false;
      scroller.classList.remove("dragging");
      // Let the click that follows through only if this was a real click.
      // Without this, dragging across a row opens whatever card you let go on.
      if (moved > 4) {
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        scroller.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => scroller.removeEventListener("click", swallow, true), 50);
      }
    }
    scroller.addEventListener("pointerup", endDrag);
    scroller.addEventListener("pointercancel", endDrag);
    scroller.addEventListener("pointerleave", endDrag);
  }


  function renderCard(t, resumeMap) {
    const card = document.createElement("div");
    card.className = "card";
    if (List.has(t.id)) {
      const badge = document.createElement("span");
      badge.className = "card-listed";
      badge.textContent = "✓";
      badge.title = "In My List";
      card.appendChild(badge);
    }
    // A Continue Watching card jumps straight back into the episode you
    // stopped on; every other card opens the title.
    card.onclick = t.resumeVideoId
      ? () => playVideo(t.resumeVideoId, t.title)
      : () => openDetail(t.id);

    const art = document.createElement("div");
    art.className = "card-art";
    if (t.hasThumbnail) {
      const img = document.createElement("img");
      img.className = "card-thumb";
      img.loading = "lazy";
      img.alt = "";
      img.src = "/api/thumb/" + t.poster;
      art.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "card-thumb placeholder";
      ph.textContent = (t.title || "?").slice(0, 1).toUpperCase();
      art.appendChild(ph);
    }
    if (t.type === "series") {
      const badge = document.createElement("span");
      badge.className = "card-badge";
      badge.textContent = t.episodeCount + " ep";
      art.appendChild(badge);
    }
    card.appendChild(art);

    const body = document.createElement("div");
    body.className = "card-body";
    const title = document.createElement("p");
    title.className = "card-title";
    title.textContent = t.title;
    body.appendChild(title);

    const sub = document.createElement("p");
    sub.className = "card-sub";
    if (t.resumeLabel) {
      sub.textContent = t.resumeLabel + " · " + remaining(t);
    } else if (t.resumeVideoId) {
      sub.textContent = remaining(t);
    } else if (t.type === "series") {
      sub.textContent = t.seasonCount === 1 ? "1 season" : t.seasonCount + " seasons";
    } else {
      sub.textContent = t.year ? String(t.year) : t.category;
    }
    body.appendChild(sub);

    const r = t.resumeVideoId
      ? { time: t.resumeTime, duration: t.resumeDuration }
      : (resumeMap && (resumeMap[t.videoId] || resumeMap[t.poster]));
    if (r && r.duration) {
      const track = document.createElement("div");
      track.className = "progress-track";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      fill.style.width = Math.min(100, (r.time / r.duration) * 100) + "%";
      track.appendChild(fill);
      body.appendChild(track);
    }

    card.appendChild(body);
    return card;
  }

  // ---------------- Title detail ----------------
  async function openDetail(id) {
    const res = await fetch("/api/title/" + id);
    if (!res.ok) return;
    openTitle = await res.json();

    detailBackdrop.style.backgroundImage = openTitle.hasThumbnail
      ? `url(/api/thumb/${openTitle.poster})`
      : "none";
    detailTitle.textContent = openTitle.title;
    detailMeta.innerHTML = "";
    metaBits(openTitle).forEach(b => detailMeta.appendChild(b));

    detailClose.classList.remove("hidden", "leaving");
    renderSourcePath(openTitle);
    if (typeof openTitle.inList === "boolean") {
      if (openTitle.inList) List.ids.add(openTitle.id); else List.ids.delete(openTitle.id);
    }
    renderListButton(openTitle.id);

    if (openTitle.type === "movie") {
      seasonPicker.classList.add("hidden");
      episodeList.innerHTML = "";
      detailPlay.textContent = "▶ Play";
      detailPlay.onclick = () => playVideo(openTitle.videoId, openTitle.title);
    } else {
      seasonPicker.classList.toggle("hidden", openTitle.seasons.length < 2);
      seasonSelect.innerHTML = "";
      openTitle.seasons.forEach((s, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = s.name + " (" + s.episodes.length + ")";
        seasonSelect.appendChild(opt);
      });
      seasonSelect.value = "0";
      seasonSelect.onchange = () => renderEpisodes(Number(seasonSelect.value));
      renderEpisodes(0);

      const resume = firstUnwatched(openTitle);
      detailPlay.textContent = resume.resuming ? "▶ Resume" : "▶ Play";
      detailPlay.onclick = () => playVideo(resume.id, openTitle.title);
    }

    detail.classList.remove("hidden");
    detail.scrollTop = 0;
    document.body.style.overflow = "hidden";
  }

  // A movie shows its own file; a series shows the folder its episodes share,
  // with each episode's own path listed underneath it in the list below.
  function renderSourcePath(t) {
    const value = t.type === "movie" ? (t.path || t.folder) : t.folder;
    if (!value) {
      detailPath.classList.add("hidden");
      return;
    }
    detailPath.classList.remove("hidden");
    detailPathValue.textContent = value;
    detailPath.querySelector(".detail-path-label").textContent =
      t.type === "movie" ? "File on disk" : "Folder on disk · " + t.fileCount + " files";
    detailPath.onclick = () => copyText(value);
  }

  // navigator.clipboard only exists on secure origins, and Notflix is reached
  // over plain http from a phone, so the textarea fallback is the path that
  // actually runs there.
  function copyText(text) {
    const done = () => {
      detailPathCopied.classList.add("show");
      setTimeout(() => detailPathCopied.classList.remove("show"), 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
    } else {
      legacyCopy(text, done);
    }
  }

  function legacyCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    // If copying is blocked outright, at least leave the text selectable.
    if (ok) done();
  }

  // Where "Play" on a series should start: the episode you were part-way
  // through, else the first one you have not started.
  function firstUnwatched(title) {
    const map = Resume.get();
    const ids = title.seasons.flatMap(s => s.episodes.map(e => e.id));
    const partial = ids.find(id => map[id] && map[id].duration &&
      map[id].time > 30 && map[id].time < map[id].duration - 60);
    if (partial) return { id: partial, resuming: true };
    const fresh = ids.find(id => !map[id]);
    return { id: fresh || ids[0], resuming: false };
  }

  function renderEpisodes(seasonIndex) {
    const season = openTitle.seasons[seasonIndex];
    const map = Resume.get();
    episodeList.innerHTML = "";
    if (!season) return;

    season.episodes.forEach(ep => {
      const row = document.createElement("div");
      row.className = "episode";
      row.onclick = () => playVideo(ep.id, openTitle.title);

      const num = document.createElement("div");
      num.className = "episode-num";
      num.textContent = ep.episode;
      row.appendChild(num);

      const art = document.createElement("div");
      art.className = "episode-art";
      if (ep.hasThumbnail) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "";
        img.src = "/api/thumb/" + ep.id;
        art.appendChild(img);
      }
      row.appendChild(art);

      const info = document.createElement("div");
      info.className = "episode-info";
      const t = document.createElement("p");
      t.className = "episode-title";
      t.textContent = ep.title;
      info.appendChild(t);

      const sub = document.createElement("p");
      sub.className = "episode-sub";
      sub.textContent = formatSize(ep.size);
      info.appendChild(sub);

      if (ep.relPath) {
        const p = document.createElement("p");
        p.className = "episode-path" + (ep.missing ? " episode-missing" : "");
        p.textContent = ep.missing ? ep.relPath + " (missing)" : ep.relPath;
        p.title = ep.path || "";
        // Tapping the path copies the full path instead of starting playback.
        p.onclick = (e) => { e.stopPropagation(); if (ep.path) copyText(ep.path); };
        info.appendChild(p);
      }

      const r = map[ep.id];
      if (r && r.duration) {
        const track = document.createElement("div");
        track.className = "progress-track";
        const fill = document.createElement("div");
        fill.className = "progress-fill";
        fill.style.width = Math.min(100, (r.time / r.duration) * 100) + "%";
        track.appendChild(fill);
        info.appendChild(track);
      }

      row.appendChild(info);
      episodeList.appendChild(row);
    });
  }

  function remaining(t) {
    if (!t.resumeDuration) return "Continue";
    const left = Math.max(0, t.resumeDuration - t.resumeTime);
    const mins = Math.round(left / 60);
    if (mins < 1) return "Almost done";
    if (mins < 60) return mins + " min left";
    const h = Math.floor(mins / 60);
    return h + "h " + (mins % 60) + "m left";
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(1) + " GB";
    return Math.round(bytes / (1024 * 1024)) + " MB";
  }

  function closeDetail(immediate) {
    const finish = () => {
      detail.classList.add("hidden");
      detail.classList.remove("closing");
      detailClose.classList.add("hidden");
      detailClose.classList.remove("leaving");
      document.body.style.overflow = "";
      openTitle = null;
    };
    detailClose.classList.add("leaving");
    // A swipe has already animated it off-screen; anything else plays the
    // exit animation first so the screen does not just blink away.
    if (immediate) return finish();
    detail.classList.add("closing");
    setTimeout(finish, 180);
  }
  detailClose.addEventListener("click", () => closeDetail());

  // ---------------- Playback hand-off ----------------
  function playTitle(t) {
    if (t.type === "movie") return playVideo(t.videoId, t.title);
    openDetail(t.id).then(() => detailPlay.click());
  }

  function playVideo(videoId, showTitle) {
    if (!videoId) return;
    const wasDetailOpen = !detail.classList.contains("hidden");
    detail.classList.add("hidden");
    searchPanel.classList.add("hidden");
    browseScreen.classList.add("hidden");
    document.body.style.overflow = "hidden";

    window.NotflixPlayer.open(videoId, showTitle, {
      onClose: () => {
        browseScreen.classList.remove("hidden");
        if (wasDetailOpen && openTitle) {
          detail.classList.remove("hidden");
          if (openTitle.type === "series") renderEpisodes(Number(seasonSelect.value || 0));
        } else {
          document.body.style.overflow = "";
        }
        loadLibrary();
      },
      onPlay: (nextId, nextLabel) => playVideo(nextId, nextLabel)
    });
  }

  // ---------------- Search ----------------
  let searchTimer = null;

  searchBtn.addEventListener("click", () => {
    searchPanel.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    searchInput.focus();
  });

  searchClose.addEventListener("click", () => {
    searchPanel.classList.add("hidden");
    document.body.style.overflow = "";
    searchInput.value = "";
    searchResults.innerHTML = "";
    searchEmpty.classList.add("hidden");
  });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 200);
  });

  async function runSearch() {
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchResults.innerHTML = "";
      searchEmpty.classList.add("hidden");
      return;
    }
    const res = await fetch("/api/search?q=" + encodeURIComponent(q));
    if (!res.ok) return;
    const { results } = await res.json();

    const resumeMap = Resume.get();
    searchResults.innerHTML = "";
    results.forEach(t => searchResults.appendChild(renderCard(t, resumeMap)));
    searchEmpty.textContent = "Nothing matches “" + q + "”.";
    searchEmpty.classList.toggle("hidden", results.length > 0);
  }

  // ---------------- Scan status ----------------
  async function pollScanStatus() {
    try {
      const res = await fetch("/api/scan-status");
      if (res.ok) {
        const s = await res.json();
        updateScanBanner(s);
        if (s.scan.scanning || s.thumbnails.running) loadLibrary();
      }
    } catch (_) { /* server restarting, ignore */ }
    setTimeout(pollScanStatus, 4000);
  }

  function updateScanBanner(s) {
    if (s.scan.scanning) {
      scanBanner.textContent =
        "Scanning your PC for videos. " + (s.scan.filesFound || 0) + " found so far.";
      scanBanner.classList.remove("hidden");
    } else if (s.thumbnails.running) {
      scanBanner.textContent =
        "Generating thumbnails. " + s.thumbnails.done + " of " + s.thumbnails.total;
      scanBanner.classList.remove("hidden");
    } else {
      scanBanner.classList.add("hidden");
    }
  }

  rescanBtn.addEventListener("click", async () => {
    await fetch("/api/scan", { method: "POST" });
    scanBanner.textContent = "Rescan started.";
    scanBanner.classList.remove("hidden");
  });

  // ---------------- Chrome ----------------
  window.addEventListener("scroll", () => {
    navbar.classList.toggle("solid", window.scrollY > 40);
  }, { passive: true });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!searchPanel.classList.contains("hidden")) return searchClose.click();
    if (!detail.classList.contains("hidden")) return closeDetail();
  });


  // ---------------- Sidebar drawer (phone) ----------------
  //
  // The drawer is the navigation on a phone: the scrolling chip row in the top
  // bar is hidden below 900px, so this is how you reach a category, My List or
  // search. It renders from the same category list the tabs use, so the two
  // stay in step automatically.

  const sidebar = $("sidebar");
  const sidebarScrim = $("sidebar-scrim");
  const sidebarNav = $("sidebar-nav");
  const sidebarCount = $("sidebar-count");
  const menuBtn = $("menu-btn");

  const CATEGORY_ICONS = {
    "All": "⌂",
    "My List": "✓",
    "Movies": "▶",
    "TV Shows": "▣",
    "Anime": "✦",
    "Clips": "✂",
    "Home Videos": "★",
    "Tutorials": "✎",
    "Music Videos": "♫",
    "Other": "…"
  };

  function openSidebar() {
    sidebar.classList.add("open");
    sidebarScrim.classList.add("open");
    menuBtn.classList.add("open");
    menuBtn.setAttribute("aria-expanded", "true");
    sidebar.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarScrim.classList.remove("open");
    menuBtn.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
    sidebar.setAttribute("aria-hidden", "true");
    if (detail.classList.contains("hidden")) document.body.style.overflow = "";
  }

  function sidebarOpen() { return sidebar.classList.contains("open"); }

  menuBtn.addEventListener("click", () => sidebarOpen() ? closeSidebar() : openSidebar());
  sidebarScrim.addEventListener("click", closeSidebar);
  $("sidebar-close").addEventListener("click", closeSidebar);
  $("sidebar-rescan").addEventListener("click", () => { closeSidebar(); rescanBtn.click(); });

  // Swiping left anywhere on the drawer dismisses it, which is the gesture
  // people already expect from a drawer.
  (() => {
    let x0 = null;
    sidebar.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, { passive: true });
    sidebar.addEventListener("touchend", e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (dx < -50) closeSidebar();
      x0 = null;
    }, { passive: true });
  })();

  function renderSidebar(cats) {
    const listCount = (library.watchlist || []).length;
    sidebarNav.innerHTML = "";

    const add = (name, count, label) => {
      const b = document.createElement("button");
      b.className = "sidebar-item" + (name === activeTab ? " active" : "");
      const icon = document.createElement("span");
      icon.className = "sidebar-item-icon";
      icon.textContent = CATEGORY_ICONS[name] || "●";
      b.appendChild(icon);
      b.appendChild(document.createTextNode(label || name));
      if (count != null) {
        const n = document.createElement("span");
        n.className = "sidebar-item-count";
        n.textContent = count;
        b.appendChild(n);
      }
      b.onclick = () => { closeSidebar(); selectTab(name); };
      sidebarNav.appendChild(b);
      return b;
    };

    add("All", null, "Home");

    const search = document.createElement("button");
    search.className = "sidebar-item";
    const si = document.createElement("span");
    si.className = "sidebar-item-icon";
    si.textContent = "⌕";
    search.appendChild(si);
    search.appendChild(document.createTextNode("Search"));
    search.onclick = () => { closeSidebar(); searchBtn.click(); };
    sidebarNav.appendChild(search);

    add("My List", listCount || null);

    const heading = document.createElement("p");
    heading.className = "sidebar-section";
    heading.textContent = "Library";
    sidebarNav.appendChild(heading);

    cats.forEach(c => add(c.name, c.count));

    sidebarCount.textContent =
      library.total + " titles · " + library.videoCount + " files";
  }

  function selectTab(name) {
    activeTab = name;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------- My List ----------------
  //
  // Stored on the PC alongside watch progress, so something saved on the phone
  // is there on the desktop too. The local set is only a mirror, kept so the
  // button and the card badges can react instantly.
  const List = {
    ids: new Set(),
    sync(items) {
      List.ids = new Set((items || []).map(t => t.id));
    },
    has(id) { return List.ids.has(id); },
    async toggle(id) {
      const optimistic = !List.has(id);
      if (optimistic) List.ids.add(id); else List.ids.delete(id);
      try {
        const res = await fetch("/api/watchlist/" + encodeURIComponent(id), { method: "POST" });
        if (!res.ok) throw new Error("failed");
        const data = await res.json();
        if (data.inList) List.ids.add(id); else List.ids.delete(id);
      } catch (_) {
        // Put it back the way it was if the PC could not be reached.
        if (optimistic) List.ids.delete(id); else List.ids.add(id);
      }
      return List.has(id);
    }
  };

  function renderListButton(id) {
    const on = List.has(id);
    detailList.setAttribute("aria-pressed", on ? "true" : "false");
    detailListText.textContent = on ? "In My List" : "My List";
  }

  detailList.addEventListener("click", async () => {
    if (!openTitle) return;
    const id = openTitle.id;
    await List.toggle(id);
    renderListButton(id);
    detailList.classList.remove("pulse");
    // Reading offsetWidth restarts the animation; without it a second tap
    // does nothing because the class never actually changed.
    void detailList.offsetWidth;
    detailList.classList.add("pulse");
    loadLibrary();
  });

  // ---------------- Swipe right to go back ----------------
  //
  // Only starts from the left edge, so it cannot fight the horizontal card
  // rows, and only tracks horizontal drags so a normal vertical scroll is
  // never hijacked.
  (() => {
    const EDGE = 32;      // px from the left edge where a drag may begin
    const TRIGGER = 90;   // px of travel that counts as "go back"
    let startX = 0, startY = 0, dragging = false, decided = false;

    detail.addEventListener("touchstart", (e) => {
      if (detail.classList.contains("hidden") || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      startX = t.clientX; startY = t.clientY;
      dragging = true; decided = false;
    }, { passive: true });

    detail.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (!decided) {
        // Let a mostly-vertical movement through as a normal scroll.
        if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; }
        if (Math.abs(dx) < 8) return;
        decided = true;
        detail.classList.add("dragging");
        detail.classList.remove("settling");
      }

      if (dx > 0) {
        detail.style.transform = "translateX(" + dx + "px)";
        const fade = String(Math.max(0.35, 1 - dx / 320));
        detail.style.opacity = fade;
        // The button lives outside the panel now, so it has to be faded along
        // with it or it hangs in mid-air over the page underneath.
        detailClose.style.opacity = fade;
        detailClose.style.transform = "translateX(" + dx + "px)";
        e.preventDefault();
      }
    }, { passive: false });

    function end(e) {
      if (!dragging) return;
      const dx = (e.changedTouches ? e.changedTouches[0].clientX : startX) - startX;
      dragging = false;
      detail.classList.remove("dragging");

      if (decided && dx > TRIGGER) {
        detail.classList.add("settling");
        detail.style.transform = "translateX(100%)";
        detail.style.opacity = "0";
        detailClose.style.opacity = "0";
        setTimeout(() => { resetDrag(); closeDetail(true); }, 180);
      } else if (decided) {
        // Not far enough - spring it back where it was.
        detail.classList.add("settling");
        detail.style.transform = "";
        detail.style.opacity = "";
        detailClose.style.transform = "";
        detailClose.style.opacity = "";
        setTimeout(resetDrag, 180);
      }
      decided = false;
    }

    function resetDrag() {
      detail.classList.remove("settling", "dragging");
      detail.style.transform = "";
      detail.style.opacity = "";
      detailClose.style.transform = "";
      detailClose.style.opacity = "";
    }

    detail.addEventListener("touchend", end, { passive: true });
    detail.addEventListener("touchcancel", end, { passive: true });
  })();

  // ---------------- Boot ----------------
  (async function boot() {
    const res = await fetch("/api/session");
    const data = await res.json();
    if (data.loggedIn) enterBrowse();
  })();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
})();
