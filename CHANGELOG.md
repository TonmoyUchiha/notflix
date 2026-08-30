# Changelog

Notable changes to Notflix, newest first. Dates are when the change landed.

---

## 2026-08-31

### Android back button no longer throws you out of the app

Pressing back on Android left the site entirely — out of Notflix, back to
typing the address in again — even when all you wanted was to close the
episode list you had just opened.

A page can't "absorb" a back press directly; it can only be given something to
go back *to*. So while anything is layered over the browse screen, one extra
history entry is parked behind it. Back lands on that entry instead of leaving,
and the topmost layer closes. Press it again and the next layer down closes.
Once nothing is open, back leaves the site as it always did.

Only one entry is ever outstanding, so history doesn't fill up with junk no
matter how many times you open and close things.

Unwinds in the order things are stacked: player → title → search → sidebar.

### PWA manifest correctness

Everything on Notflix's side of PWA installability now checks out:

- Served as `application/manifest+json` rather than plain `application/json`
- Added `id`, so Chrome identifies the app consistently across updates
- Added `maskable` icon variants, so Android can shape the icon to the
  launcher instead of padding a square into a white box
- Added `display_override`

This does **not** by itself make the app installable on Android — that needs
HTTPS, which is a property of how you reach the server, not of the app. See
the README.

---

## 2026-08-30

### Title detail is now a modal

Opening a show used to replace the whole screen, which made it feel like
navigating away to somewhere you then had to come back from. It's now a
centred panel over the dimmed, blurred browse screen — a peek at a title
rather than a different place. Clicking outside it closes it.

On phones it still fills the screen, which is also what keeps the swipe-back
gesture feeling natural.

### Continue watching no longer commits you

Those cards used to start playing the moment you touched them, with no way to
pick a different episode. They now open the title, with its full episode list.
Nothing is lost: the Play button already resumes exactly where you stopped.

### Fixed: two back buttons on the title screen

Two separate causes, both fixed:

1. Opening a title **from search** left the search panel open behind it, so
   the title's back arrow and search's ✕ were both on screen and returning to
   browsing took two presses. Opening a title now dismisses search — from any
   route, since it's handled in one place rather than at each call site. Your
   query is kept, so reopening search brings the results straight back.

2. The title's back button had been moved outside the title screen (to escape
   a transformed ancestor breaking `position: fixed`) and nothing hid it when
   the player opened over the top — so the player's arrow and the title's
   arrow appeared together. It now lives inside the modal but outside its
   scrolling area, which pins it without `position: fixed` *and* means hiding
   the modal hides it.

### Clicking the video pauses it (desktop)

A click only toggled the controls, which made the player feel dead on a PC. A
mouse already reveals the controls by moving, so the click is free to do what
every web player does with it: play/pause. Double-click goes fullscreen.

Touch is deliberately unchanged — a finger has no hover, so a tap is still the
only way to raise the controls, and seeking is still the double-tap.

### Rows: arrows only on desktop

The hidden scrollbar left a plain mouse with no way to scroll a row at all.
Arrows at each end now do it. The mouse wheel is deliberately *not* captured:
converting a vertical wheel into horizontal movement hijacked the page scroll
whenever the pointer happened to be over a row.

`overflow-x: hidden` on pointer devices removes every remaining by-hand way to
scroll a row sideways while leaving the arrows working. Touch keeps
`overflow-x: auto`, because a finger has nothing but the swipe.

### A warmer, more reactive interface

- A wash of colour behind the whole page rather than flat near-black
- Each shelf carries its own accent — My List teal, Anime purple, TV Shows
  blue, Clips teal — tinting its title bar, its arrows and the glow under its
  cards, so a row reads as a place rather than another identical strip
- Cards lift and scale on hover with a shadow in their shelf's colour, and the
  artwork drifts in slightly slower than the card moves
- Pill tabs with a gradient on the active one, pill buttons, circular arrow
  bubbles, rounded sidebar and episode rows

All hover effects are behind `(hover: hover) and (pointer: fine)` so nothing
sticks on a phone, and the lot is disabled under `prefers-reduced-motion`.

### Fixed: a previous video's subtitle stuck over the next one

`open()` awaited `/api/playinfo` with nothing stopping a superseded call from
carrying on. Start an episode, back out while that request is still in flight,
play another — and the first request would eventually resolve and apply *its*
source and subtitle tracks over the video already playing. It only showed up
when the first request was slow, which is exactly what happens the first time
a file is played and the server has to `ffprobe` it. Hence "sometimes".

Each `open()` now carries a sequence token and stops if a newer one has
started.

### Player: 5-second quick seek, longer controls on touch

Quick seek is 5s (was 10s), from a single constant that also labels the
buttons. Controls stay up 6s on touch, up from 3.2s for everything — on a
phone every action is reveal-then-aim-then-tap, and 3.2s ran out mid-reach.
Mouse keeps the shorter delay, since moving the pointer re-triggers it.

### Fixed: the service worker served a stale app forever

It was cache-first under a cache name that never changed, so a phone that had
opened Notflix once served that copy of the HTML/CSS/JS indefinitely and never
received any later fix. Now network-first with the cache as an offline
fallback, so updates land while the app still opens when the PC is off.

---

## 2026-08-30 (earlier)

### Start automatically with Windows

Two ways, both hidden, no console window:

- `install-autostart.bat` — a Startup-folder shortcut. No admin rights.
- `install-autostart-with-recovery.bat` — the same via Task Scheduler, which
  additionally restarts Notflix if it crashes.

`notflix-status.bat`, `stop-notflix.bat` and `uninstall-autostart.bat` handle
whichever is installed. Output goes to `data/notflix.log`, since a hidden
process has no window to print to.

Also: a clear message when the port is already in use (almost always means
Notflix is already running) instead of an unhandled stack trace.

### Fixed: an entire drive skipped by the scanner

Three stray `.vpk` shader files at the root of `H:` were enough for the
game-detection heuristic to classify the whole drive as a game install and
skip it — taking every video on that drive with it.

Two problems, both fixed: the signal was too weak (any 2+ files with
game-ish extensions, with no `.exe` or install structure required), and the
blast radius was too large (a heuristic meant to skip one game folder was
allowed to fire on a whole drive).

Game-asset extensions now need corroboration before they count, and a scan
root is never pruned wholesale — a false positive there costs an entire drive.

---

## 2026-08-29

### A stable address for your phone

Your router hands the PC a new IP periodically, which breaks a home-screen
icon. Notflix now answers to `notflix.local` on the local network via a
built-in mDNS responder, so the address never has to change.

**iPhone only.** Android can't resolve `.local` names in a browser on any
version — its DNS has no equivalent of Apple's Bonjour, and Chrome doesn't do
mDNS lookups itself. On Android, use the IP and give the PC a fixed one (see
the README).

### Watch progress and My List live on the PC

Both used to be per-browser. They're now kept on the PC, so stopping an
episode on one device and opening Notflix on another picks up in the same
place. The Continue watching row shows the exact episode you stopped on and
how much is left.

Progress is written the moment it changes, atomically. It used to be debounced
by a second, which lost the last position whenever the PC was shut down inside
that window — exactly when you stop watching and walk away.

Watch history also survives a drive being unplugged or asleep during a scan:
a missing video keeps its entry rather than being deleted the moment it can't
be found.

### Subtitles

Embedded tracks and sidecar files (`.srt`, `.ass`, a `Subs\` folder) are both
found and offered in one picker, converted to WebVTT on demand so you can
switch language or turn them off mid-episode. Your choice is remembered by
*language*, so picking English once carries to the next episode.

### Sidebar, floating back button, swipe-back

The phone gets a sidebar for navigation. The back button on a title floats and
stays put however far down the episode list you scroll — it previously scrolled
away with the list, because a transformed ancestor made `position: fixed`
resolve against the scrolling element rather than the viewport.

### Where things came from

Every title shows the file or folder it came from on disk. For a series, each
episode also shows its own path relative to that folder. Tapping copies it.

### Repeatable scanning

Folder listings come back in whatever order the filesystem feels like, so the
same drive could sort differently between scans. Every listing is now sorted
with an ordinal comparison (not locale-dependent), and every decision that
could otherwise go either way has a fixed tiebreak.
