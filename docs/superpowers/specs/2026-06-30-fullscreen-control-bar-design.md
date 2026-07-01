# Fullscreen Visualizer Control Bar + Idle Auto-Hide — Design Spec

**Date:** 2026-06-30
**Status:** Draft — awaiting user review before planning
**Feature branch:** TBD (feature branch + PR per repo convention)
**Builds on:** `2026-06-29-milkdrop-visualizer-design.md` (Task 10 fullscreen control)

## 1. Goal

Give the **fullscreen visualizer** a bottom control bar with the same look and behavior as
YT Music's native **video** player bar, plus a modern **idle auto-hide** pattern that applies to
**both** the visualizer fullscreen and the native video fullscreen. Screenshot #33 (visualizer
fullscreen) currently shows no controls; screenshot #32 (video fullscreen) is the visual
reference the new bar must match.

## 2. Root constraint (established from the code)

The fullscreen element is `_canvasHost` (a `position:fixed` overlay). In fullscreen, only that
element and its descendants render — YT's real player bar lives outside it and is therefore
invisible. **Any bar shown in visualizer fullscreen must be a child of `_canvasHost`.**

Consistent with `visualizer.js`'s established philosophy (clone/proxy YT controls rather than
reparent its fragile web components — e.g. the Visualizer segment is a deep clone, preset-skip
proxies canvas clicks), the bar **drives YT's real controls; it does not replace playback logic**.
Expected **zero Swift changes** — all transport is client-side JS on `<video>` + `mediaSession` +
best-effort proxy clicks of YT's player-bar buttons.

## 3. Decisions (locked via brainstorming)

| Decision | Choice |
|---|---|
| Control set | **Transport + presets**: Prev / Play-Pause / Next, scrubbable seek + time, thumbnail + title/artist, volume, preset ⟨◀ name ▶⟩, exit-fullscreen |
| Bar visibility | **Fullscreen only** (same as YT video). Windowed now-playing keeps today's hover FS button; no bottom bar. |
| Preset name (windowed) | Move today's bottom-center toast → **top-center** of the visualization |
| Preset name (fullscreen) | **Folded into the bar** (no toast); truncated with ellipsis; full name in `title`/`aria-label` |
| Styling | **Match YT's native video bar exactly.** Shared elements look identical; new preset controls reuse the native icon style, sizing, hover, and layout so they read as native. |
| Idle auto-hide scope | Applies to **both** surfaces: our bar (visualizer) **and** YT's real `ytmusic-player-bar` (native video fullscreen), via one shared controller |
| Idle timeout | **2500 ms** |
| Transport wiring | Proxy-click YT's real player-bar buttons (best-effort selectors) with `<video>` play/pause fallback; seek/volume via `<video>`; title/thumb via `mediaSession.metadata` |
| Native changes | **None expected** |

## 4. Architecture

All new code lives in `youtube-music-player/Resources/visualizer/visualizer.js`, extending the
Task 10 fullscreen module. No new files (except one harness check). Three units:

### 4.1 `createIdleController(opts)` — pure state machine (isolated, testable)

No DOM dependency. Owns the single 2500 ms timer, movement threshold, locks, and grace flag.

```
createIdleController({ timeout=2500, threshold=8, grace=500, onShow, onHide })
  → { activity(x, y), pointerDown(), key(), focusIn(), setLock(name, bool), destroy() }
```

- `activity(x, y)`: ignore if delta from last (x, y) < `threshold`; else `onShow()`, clear timer,
  re-arm (unless any lock held).
- `setLock(name, bool)`: named locks `{ hover, focus, scrub }`. While any lock is true, the timer
  never fires a hide; releasing the last lock re-arms.
- After an auto-hide, a `justHidden` window (`grace` ms) suppresses re-reveal from synthetic
  mousemove (fullscreen entry + reflow fire spurious moves).
- `focusIn()`: forces `onShow()` and holds visible while focus lock set.
- `destroy()`: clears timers. Idempotent.

### 4.2 Chrome adapters (thin; wire the controller to a surface)

Bound on `fullscreenchange`. Exactly one active at a time, chosen by fullscreen element:

- **Visualizer adapter** (`document.fullscreenElement === _canvasHost`):
  `onShow` = reveal bar + scrim, `cursor:auto` on host. `onHide` = fade bar + scrim, `cursor:none`.
- **Video adapter** (fullscreen element is not our host = YT native video fullscreen):
  `onShow` = remove `.milkviz-idle` from the fullscreen root. `onHide` = add `.milkviz-idle`,
  which force-hides `ytmusic-player-bar` (`opacity:0;pointer-events:none !important`) and sets
  `cursor:none`. ponytail: co-exists with YT's own ~3s hide — ours fires earlier at 2500 ms; both
  reveal on activity, so they align rather than fight.

Activity listeners (`mousemove`, `pointerdown`, control `keydown`, `focusin`, bottom-edge peek
zone) are attached at the document level while any element is fullscreen, removed on exit. Both
adapters share the same `createIdleController` instance semantics.

### 4.3 Player bar (visualizer only) — child of `_canvasHost`, `position:absolute; bottom:0`

Layout mirrors YT's native video bar:

```
▁▁▁▁▁▁▁▁▁ seek track (thin, full width, red progress, scrubbable) ▁▁▁▁▁▁▁▁▁
[⏮ ⏯ ⏭]  0:25 / 4:53    🖼 Title — Artist          🔊 vol   ⟨ ◀ PresetName ▶ ⟩   ⤢
```

| Element | Source of truth / action |
|---|---|
| Prev / Play-Pause / Next | proxy-click YT player-bar buttons (best-effort selectors); fallback: `<video>.play()/pause()` for play-pause, buttons hidden if not found |
| Seek track + time | read/write `document.querySelector('video')` `.currentTime` / `.duration`; drag sets `scrub` lock |
| Volume | `<video>.volume` (+ mute toggle reflects `aria-pressed`) |
| Thumbnail + title/artist | `navigator.mediaSession.metadata` (`.title`, `.artist`, `.artwork`) |
| Preset ⟨◀ name ▶⟩ | call existing `doLoadPreset(±1)`; label updates on every preset change, truncated w/ ellipsis |
| Exit-fullscreen (⤢) | `document.exitFullscreen()`; the top-right FS button is suppressed while in fullscreen |

State sync: bind `<video>` events `timeupdate` / `play` / `pause` / `volumechange` for seek, time,
play icon, volume; reuse the existing 3 s track poll (`_checkTrack`) for title/thumb. No new
polling loop.

## 5. Visuals & motion (from 2026 research synthesis)

- **Match reference (#32):** same glyphs/stroke weights, spacing, thin red progress line,
  `M:SS / M:SS` time format, thumbnail+title treatment. New preset controls use identical icon
  style, size, and hover treatment.
- **Scrim:** bottom eased gradient (multi-stop, ~30% of viewport height) behind the bar; fades
  *with* the bar — never a permanent band over idle art.
- **Reveal:** ~180 ms, `opacity 0→1` + `translateY(10px→0)`, ease-out `cubic-bezier(.16,1,.3,1)`
  (snappy).
- **Hide:** ~350 ms ease-in, then `visibility:hidden` after transition (gentle).
- **Cursor:** same timer sets `cursor:none` when idle.
- **Peek-on-approach:** entering the bottom ~15% edge zone counts as activity (subtle reveal).

## 6. Accessibility

- Controls stay in the DOM (opacity/visibility, never `display:none`); `visibility:hidden` applied
  only after the fade, flipped back the instant `focusin` fires.
- `focusin` reveals + holds (focus lock), like hover-lock. Focus rings kept (never `outline:none`).
- `aria-label` / `aria-pressed` on play-pause and mute, updated on state change. Preset label
  `aria-live="polite"`.
- `prefers-reduced-motion`: drop `translateY`, ~0 ms transitions; hide *behavior* preserved.

## 7. Theming (LightThemeEngine survival)

The bar sits over the dark visualizer canvas → force white-on-dark inline with `!important`,
including `-webkit-text-fill-color`, exactly as `showToast` already does (see the existing toast
comments). Applies to text, icons, and time. The video adapter touches YT's own bar (already
themed correctly for fullscreen) so needs no color forcing.

## 8. Lifecycle & teardown

- Bar + idle listeners created in/around `addFullscreenControl`; torn down in
  `removeFullscreenControl` and on `setActive(false)` — no timer/listener/DOM survives the
  visualizer being off or fullscreen being exited.
- `_fsChangeHandler` extends to: pick the adapter, show/hide the bar (bar only exists in
  visualizer fullscreen), and start/stop the shared activity listeners.
- The `.milkviz-idle` class + its CSS are removed on fullscreen exit so YT's video bar returns to
  YT's own control.

## 9. Preset label routing

`doLoadPreset` calls a new `announcePreset(name)` that routes by state:
- Visualizer **fullscreen** → update the bar's preset label (truncated).
- Visualizer **windowed** → top-center toast (relocated from today's bottom-center `showToast`).

## 10. Testing

ponytail: one runnable check. `createIdleController` is pure, so a small harness check
(`harness/`) asserts: sub-`threshold` movement does **not** reveal; any lock blocks hide; releasing
the last lock re-arms; `focusIn()` reveals. No DOM, no framework.

## 11. Out of scope (skipped, add later if wanted)

- Reparenting YT's bar into fullscreen (unwanted buttons, no preset controls, breaks web
  components).
- Like/dislike, CC, ⋮ menu, shuffle, repeat (not in the chosen control set).
- Beat-synced chrome glow, velocity-based reveal (research: gimmicky / tests poorly).
- Our custom bar over native video (rejected in favor of driving YT's real bar).
