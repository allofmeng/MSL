# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**MSL** (skin id `msl`) — a WebUI **skin** for **Decaid**, the middleware that drives a Decent Espresso DE1 (and "Bengle") machine. It is a plain static site: no bundler, no transpiler, no npm dependencies, no framework. `src/package.json` exists only to declare `{"type":"module"}`. Browser loads `index.html`, which pulls native ES modules via an importmap (`src/` → `./src/`).

It was called **Streamline.js** (id `streamline.js`) until v0.0.1. The rename covered the display name, the skin id and the docs — it deliberately did **not** touch any persisted identifier, because those name storage rather than the product and renaming them silently discards user data:

| Kept as `streamline*` | Why |
|---|---|
| `streamline:languagechange` / `:unitchange` / `:scaleupdate` | cross-module DOM event names; renaming is all-or-nothing and buys nothing |
| `streamline-app`, `streamline` (bridge KV namespaces) | hold live user settings and the legacy-profile migration source |
| `streamline.cupWarmerTarget`, `.dye2Enabled`, `.dyeStripMode`, `.steamStopMode`, `.steamStopModeFallback` | localStorage prefs; cup-warmer.js carries an explicit warning about orphaning them |
| `streamline_scale_device_id`, `streamlineHelpHidden`, `streamlineHelpLaunches` | persisted keys |
| `showOnStreamlineDashboard` | a field in DYE2's KV contract — a third-party name, not ours |
| `streamline_entry_page_setup` etc. in `src/css/*.css` | citations of the original `skin.tcl` |
| `Streamline` / `Streamline Dark` rows in the translation CSV | DE1-app theme names, unrelated to this skin |

`skin-manifest.json` + `src/version.js` (`APP_VERSION`, `SKIN_ID`) identify the skin to Decaid. **Bump `APP_VERSION` and `skin-manifest.json` `version` together when cutting a release** — settings.js compares `APP_VERSION` against the on-disk version from `GET /webui/skins` to show "reload to apply". Keep the version **numeric**: `settings.js` `compareVersions()` parses it per dot-segment with `parseInt` and Decaid's updaters use semver, so a version carrying the product name is not safe.

## The middleware (Decaid)

Source lives at `/Users/markc/Documents/streamline_js/reaprime/reaprime` — a Flutter app. It is the authority on every API this skin calls; when behaviour looks wrong, read its Dart, not just this skin.

**Names**: REA → ReaPrime → Streamline Bridge → **Decaid** (renamed 2026). The internal identifiers deliberately did *not* change — Dart package `reaprime`, bundle id `net.tadel.reaprime`, database `streamline_bridge`, plugin extension `.reaplugin`. That's why this codebase says "rea" everywhere (`reaHostname`, `REA_PORT`, `getReaSettings`). Use **Decaid** in prose, keep `rea*` in code.

**Ports**: REST + WebSocket on **8080** (`/api/v1/...`, `/ws/v1/...`), installed skins served on **3000**, interactive API docs on **4001** (start Decaid, open `http://localhost:4001`, or serve its `assets/api/`). CORS is open by default, so a skin served from any other origin can talk to the gateway.

**Its docs are the API reference for this skin** — read these before guessing at an endpoint:

| Doc (under the reaprime repo) | Covers |
|---|---|
| `doc/Skins.md` | The full REST/WebSocket API + skin dev & deployment. The single most useful file. |
| `doc/Profiles.md` | v2 JSON profiles, content-based hash IDs, dedup, import/export |
| `doc/DeviceManagement.md` | Device discovery, transports (BLE/USB), auto-connect |
| `doc/Plugins.md` | `.reaplugin` host API — relevant to the plugin sockets/endpoints this skin consumes |
| `doc/RELEASE.md` | Release/tag workflow |

**Machine link**: Decaid talks to the DE1 over Bluetooth or USB serial and to scales (Felicita Arc, Decent Scale, Bookoo Mini) over BLE. Auto-stop at target weight, tare, and shot history all happen middleware-side. **Gateway modes** — `disabled` (full local control) / `tracking` (monitor + stop at weight) / `full` (remote control) — are what `ensureGatewayModeTracking()` in app.js is negotiating. Decaid also has a **device simulator**, so this skin can be exercised with no hardware attached.

**Bundled plugins** this skin integrates with: `settings.reaplugin`, `time-to-ready.reaplugin` (the `timeToReady` socket), `visualizer.reaplugin`, `decent-profile.reaplugin` (`profileGenerated` socket), plus the third-party `dye2.reaplugin` consumed read-only by `dyeStrip.js`.

**Embedded-WebView lifecycle (Android/iOS)**: Decaid pauses the WebView when backgrounded and, after **10 minutes**, unloads the page and reloads the skin from scratch on return. Any state that must survive that has to be in the Decaid API or browser storage — this is the reason for the IndexedDB/localStorage persistence split described below, not mere caching.

**Link handling in the WebView**: navigations to `localhost:3000` and the settings plugin load in place; anything else opens in the system browser. `target="_blank"` popups are blocked (`javaScriptCanOpenWindowsAutomatically: false`), so external links (Visualizer, Derek) must go through a delegated click handler using `window.open(url,'_blank')` with a `location.href` fallback.

**Cross-skin assets**: `GET /api/v1/webui/skin-assets/{skinId}/{path}` serves raw files out of any *installed* skin — the way to share icons/fonts/components instead of duplicating them.

## Running it

Three ways, cheapest first:

1. **Any static server + a live Decaid elsewhere on the network.** ES modules and the router's HTML-fragment fetches don't work from `file://`.
   ```
   python3 -m http.server 8000     # then open http://localhost:8000/
   ```
   The backend host defaults to `window.location.hostname:8080`; point it at the gateway from Settings, which writes `localStorage.reaHostname` (`src/modules/ui.js`, `API_BASE_URL` in `api.js`).
2. **Decaid "Live-edit from folder…"** (desktop) — point Decaid's Settings at *this directory*. It serves the folder directly without copying, so edit + refresh is the whole loop. Best fidelity, since the skin then runs on `:3000` same-origin with the gateway.
3. **Install from .zip** or `POST /api/v1/webui/skins/install/url` — what end users get; only needed to test the install path itself.

## Releasing

MSL is a **fork of `allofmeng/streamline_project`** and is not published yet, so release plumbing is deliberately unfinished in two places:

- **Decaid side (the Decaid maintainer's change).** `skin_sources.json` still lists `allofmeng/streamline_project` and the release validation still expects `id == "streamline.js"`. Both need MSL's repo and `id == "msl"` before release-based install/update works at all. Until then Decaid sees `msl` as a *new* skin and installs it beside the old one rather than upgrading it.
- **Skin side (ours).** `skinRepoSlug()` in `settings.js` no longer hardcodes a fallback repo — see the `TODO(MSL)` there; restoring it with MSL's own slug is one line. It only matters for builds whose install metadata is missing (live-edit, zip); release installs get the correct slug from `reaMetadata.sourceUrl` automatically. Do **not** point it back at the upstream repo — a fork restarts its version numbering, so the badge would read "Update available" permanently.

Decaid pulls skins from GitHub Releases listed in the middleware's `skin_sources.json`. A release zip must have **`skin-manifest.json` at its root** with an `id` matching what the middleware validates, and the middleware validates the zip's contents (whitelisted paths, no `:` in filenames). The filename is `skin-manifest.json` rather than `manifest.json` on purpose — `index.html` may ship a PWA `manifest.json` with an incompatible schema; Decaid prefers the skin-specific one and falls back to `manifest.json`, then to the directory name, for the skin id.

No build step, no linter config, no test runner in this tree. Several modules' header comments reference `node --test test/` and `test/README.md` — **that directory is not present in this copy**; treat those comments as intent, not as runnable commands. Edited JS/CSS/HTML is live on reload.

CSS is pre-built Tailwind output committed to the repo (`src/css/app.css`, Tailwind v3 minified). `src/css/input.css` and `src/input.css` are stale sources for two different Tailwind majors and are not wired to anything; hand-write additions in `src/css/main.css` (or the per-feature CSS files) rather than trying to rebuild `app.css`.

## Architecture

**One page, three sub-pages.** `index.html` is the only real document. `src/modules/router.js` maps `?page=settings|profile_selector|profile_editor` to an HTML fragment, fetches it, splices its `#scaled-content` into `#subpage-host`, hides `#main-page`, and dynamically imports that page's init function. Returning to the main page calls `showMainPage()`. Consequences worth remembering:

- Sub-page HTML files are fragments, not standalone documents — they don't load CSS or scripts of their own.
- `#plotly-chart` is **shared** between the main page and the profile selector, which is why `showMainPage()` clears and repaints it.
- Main-page data init is lazy and idempotent: `window.app.initMainPageOnce()` (app.js). Booting straight onto a sub-page URL skips it; the router triggers it on return.

**Fixed design canvas.** Layout is absolute-positioned against a **1920×1200** design space (Figma-derived; comments cite Figma node ids). `src/modules/scaling.js` CSS-transforms `#scaled-content` to fit the viewport. Don't reach for responsive breakpoints — position in design pixels and let scaling.js handle the rest.

**Boot order** (`app.js` DOMContentLoaded): chart → `initI18n` → `initUnits` → `ui.initUI` → `initScaling` → numpad/time-picker → `initRouter` → `initMainPageOnce` (unless on a sub-page). `initMainPageOnce` loads history, profiles, then opens ~8 WebSockets. Order is load-bearing in places (e.g. `setMachineModel()` must run before the first `ui.updateSteamDisplay()` so Bengle-gated UI restores correctly).

**`src/modules/api.js` is the only network layer.** All REST (`http://{host}:8080/api/v1/...`) and all WebSockets (`ws/v1/machine/snapshot`, `machine/shotSettings`, `machine/shotState`, `scale/snapshot`, `devices`, `display`, `update`, plus plugin sockets) live there, along with short-TTL caches for DE1 settings. UI modules never `fetch` directly.

**`window.app`** is the cross-module escape hatch (`{api, ui, chart}` plus callbacks). Router and inline HTML handlers go through it; module-to-module code should use real imports.

**Pure/DOM-free modules** — `machine.js`, `machine-link.js`, `socket-slot.js`, `screensaver-policy.js`, `steam-mode.js`, `cup-warmer.js`, `chart-autoscale.js`, `historical-gflow.js`, `time-picker-core.js`. Kept free of browser globals deliberately so they stay unit-testable. **Preserve that property**; put DOM work in the caller.

Two of these encode hard-won middleware workarounds — read their header comments before touching:
- `socket-slot.js` — close-and-silence before re-open; reaprime binds sockets to a De1 *instance* and never re-binds them.
- `machine-link.js` — machine link state is derived edge-triggered from the surviving `/ws/v1/devices` aggregator feed, because the snapshot socket goes open-but-silent after a machine power-cycle. Device ids are byte-identical across a power-cycle, so id-diffing would never fire.
- `screensaver-policy.js` — the screensaver is a pure function of the *confirmed* machine state; nothing but an explicit user wake may send `idle`.

**Persistence** is split three ways, on purpose:
- **IndexedDB** (`idb.js`, db `shot_history` v8): `shots`, `settings`, `decent_emails`. Survives WebView process kills and Decaid's 10-minute background unload; the shot cache is what makes history paint instantly at boot.
- **localStorage**: small sync-read UI prefs — `theme`, `language`, `reaHostname`, `uiZoom`, screensaver/visualizer/water-tank keys, `streamline.*` feature keys. Some values (e.g. temp unit) are written to *both*, IDB as the durable copy.
- **Bridge KV store** (`/api/v1/store/...`): values that belong to the machine/user rather than the browser (numpad recent values, etc.).

**i18n** (`i18n.js`) parses `src/ui/de1 gui translation - Sheet1.csv` at runtime — the CSV header row *is* the language list. Keys are the English strings, matched case-insensitively. The router calls `translatePage()` on every freshly injected fragment.

**Units**: the machine and the bridge always speak **Celsius** on the wire. `units.js` is a display-only conversion layer — never persist or transmit Fahrenheit.

**Machine model gating**: `isBengleMachine()` (`machine.js`) keys off the model string from `GET /machine/info` containing "bengle". There is no capability endpoint; that string is the only signal. Cup warmer, load-cell calibration and some steam UI are Bengle-only.

## Conventions in this codebase

- Comments here carry *why*, often at length, and frequently document a bug that the code's shape exists to prevent. Don't strip them when refactoring; extend them when you change the reasoning.
- A `ponytail:` comment marks a deliberate simplification and names its ceiling.
- Logging goes through `logger.js` (`logger.debug` is a no-op unless `setDebug(true)` — app.js currently enables it).
- The `src/profiles/*.json` files are sample/fixture profiles; nothing in the code loads them. Real profiles come from the bridge.
- `src/vendor/` (easymde, iro) and `src/modules/plotly-3.1.0.min.js` and `reconnecting-websocket.js` are vendored third-party — don't hand-edit.
- Root `app.css` is a stale duplicate of an older `src/css/app.css`; `index.html` loads the one under `src/css/`.
