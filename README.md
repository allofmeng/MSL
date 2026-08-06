# MSL

A WebUI **skin** for [Decaid](https://github.com/tadelv/reaprime) — the middleware that drives a
[Decent Espresso](https://decentespresso.com) DE1 (and "Bengle") machine. MSL replaces the machine's
tablet UI: profiles, live shot graph, shot history, machine settings, and a full profile editor.

It is a **plain static site**. No bundler, no transpiler, no npm dependencies, no framework — the
browser loads `index.html` and pulls native ES modules through an importmap. Editing a file and
refreshing is the entire development loop.

- **Runs on:** an in-app WebView on a tablet, mounted on the machine. Design for touch first.
- **Design canvas:** a fixed 1920×1200 space that is CSS-transformed to fit whatever screen it lands on.
- **Talks to:** Decaid's REST + WebSocket API on port 8080. There is no direct Bluetooth from the skin.

MSL is a fork of [`allofmeng/streamline_project`](https://github.com/allofmeng/streamline_project)
(called *Streamline.js* until v0.0.1).

---

## Quick start

Three ways to run it, cheapest first.

**1. Any static server, with a live Decaid elsewhere on the network.**

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

ES modules and the router's HTML-fragment fetches do not work from `file://`, so a server is required.
The backend host defaults to `window.location.hostname:8080`; point it at your gateway from
Settings, which writes `localStorage.reaHostname`.

**2. Decaid's "Live-edit from folder…"** (desktop) — point Decaid's settings at this directory. It
serves the folder directly, so the skin runs on `:3000` same-origin with the gateway. Best fidelity.

**3. Install from a release zip**, or `POST /api/v1/webui/skins/install/url` — what end users get.
Only needed to test the install path itself.

Decaid ships a **device simulator**, so all of the above work with no hardware attached.

### Tests

```bash
node --test test/
```

Only the DOM-free modules are covered — they are kept browser-global-free precisely so they can be
imported by `node --test` without a DOM. There is no other build or lint step.

---

## Program structure

```
index.html                  The only real document. Header, shot settings, chart, history.
skin-manifest.json          id / name / version — how Decaid identifies the skin.
LICENSE                     GNU GPL v3.
src/
  version.js                APP_VERSION + SKIN_ID. Bump with skin-manifest.json.
  css/
    app.css                 PRE-BUILT Tailwind output, committed. Do not hand-edit; see below.
    main.css                Hand-written app CSS: layout fixes, theme variables, header layout.
    dark-mode.css           Dark theme variable overrides.
    profile-editor.css      The editor is a plain stylesheet, not Tailwind utilities.
    *.css                   One file per feature (numpad, context menu, help overlay, …).
  modules/                  All application logic (see the table below).
  profiles/                 Sub-page fragments: profile_selector.html, profile_editor.html.
                            The *.json files are sample fixtures; nothing loads them.
  settings/                 settings.html + settings.js (the largest single feature).
  ui/                       Fonts, icons, and the translation CSV.
  vendor/                   Third-party (EasyMDE, iro.js). Never hand-edited.
test/                       node:test files for the DOM-free modules.
```

### Modules

| Module | Responsibility |
|---|---|
| `app.js` | Boot sequence, WebSocket wiring, `window.app` assembly |
| `api.js` | **The only network layer** — all REST and all WebSockets live here |
| `router.js` | `?page=…` → fetch an HTML fragment, splice it in, import its init |
| `ui.js` | Shared DOM helpers: steppers, toasts, gestures, screensaver |
| `chart.js` | Live and historical Plotly shot graph |
| `history.js`, `shotData.js`, `shotSummary.js` | Shot history browsing and the footer panels |
| `profileManager.js` | Favourite buttons, the frequent-profiles strip, sending a profile |
| `profile_selector.js`, `profile_editor.js` | The two profile sub-pages |
| `settings/settings.js` | Every settings page, including firmware update |
| `idb.js` | IndexedDB (`shot_history`): shots, settings, emails |
| `i18n.js` | Runtime CSV translation loading |
| `units.js` | Display-only °C/°F conversion |
| `scaling.js` | Fits the 1920×1200 canvas to the real viewport |
| `dyeStrip.js` | Read-only integration with the third-party DYE2 plugin |

**Pure, DOM-free modules** — `machine.js`, `machine-link.js`, `socket-slot.js`,
`screensaver-policy.js`, `steam-mode.js`, `cup-warmer.js`, `chart-autoscale.js`,
`historical-gflow.js`, `time-picker-core.js`, `firmware-progress.js`, `led-color.js`,
`loadcell-cal.js`. Kept free of browser globals on purpose so they stay unit-testable. Preserve that
property: put DOM work in the caller.

---

## Architecture

**One page, three sub-pages.** `index.html` is the only document. `router.js` maps
`?page=settings|profile_selector|profile_editor` to an HTML fragment, fetches it, splices its
`#scaled-content` into `#subpage-host`, hides `#main-page`, and dynamically imports that page's init
function. Consequences: sub-page HTML files are *fragments* (they load no CSS or scripts of their
own), and `#plotly-chart` is shared between the main page and the profile selector.

**Fixed design canvas.** Layout is positioned against a 1920×1200 space (Figma-derived; comments cite
node ids). `scaling.js` CSS-transforms `#scaled-content` to fit the viewport. Don't reach for
responsive breakpoints — position in design pixels and let scaling handle the rest. Note that a CSS
transform makes `getBoundingClientRect()` post-transform while `style.transform` values are
pre-transform; code that mixes them divides by the scale factor.

**One network layer.** Every `fetch` and every WebSocket lives in `api.js`, along with short-TTL
caches. UI modules never call `fetch` directly.

**Persistence is split three ways, on purpose:**

| Store | Holds | Why |
|---|---|---|
| IndexedDB | shots, durable settings | Survives the WebView process being killed |
| localStorage | theme, language, host, small UI prefs | Needs synchronous reads at boot |
| Decaid KV store | values belonging to the machine/user | Follows the machine, not the browser |

This split exists because Decaid **unloads the WebView after 10 minutes in the background** and
reloads the skin from scratch. Anything that must survive that is in a store or in the API.

---

## Ideas worth stealing

Things in here that solved a non-obvious problem. Each one has a long comment at the top of its file
explaining the failure it prevents — read those before changing them, and treat this list as a map
of where the interesting reading is.

- **`socket-slot.js` — close-and-silence before re-open.** The middleware binds sockets to a machine
  *instance* and never re-binds them, so a naive reconnect leaves you listening to a dead object.
- **`machine-link.js` — edge-triggered state from a surviving feed.** After a machine power-cycle the
  snapshot socket goes open-but-silent, and device ids are byte-identical across the cycle, so
  id-diffing never fires. Connection state is derived from the aggregator feed instead.
- **`screensaver-policy.js` — a pure function of confirmed machine state.** Nothing but an explicit
  user wake may send `idle`. Sleep bugs on a coffee machine are the kind users notice at 6am.
- **`firmware-progress.js` — NDJSON framing split from transport.** Chunk boundaries are not line
  boundaries, so framing is its own tested function. 100% means "bytes sent", not "update applied":
  only the `done` event is success, and a truncated stream is a failure.
- **Touch gestures for a WebView** (`setupPressAndHold` in `ui.js`). Never `preventDefault()` a
  `touchstart` on anything inside a scroller — it cancels the platform's panning for the whole
  gesture. Cancel the press on movement instead and suppress the synthetic click at the `click`
  listener. HTML5 drag-and-drop is unusable here (`dragstart` never fires); the step reorder in
  `profile_editor.js` uses pointer events with live DOM reflow.
- **A header that yields instead of overlapping.** Two absolutely-positioned clusters cannot see each
  other; making the header a flex row lets the favourites strip give up width as optional buttons
  appear, and it scrolls for the rest.
- **`i18n.js` — the CSV header row *is* the language list.** Translations are a spreadsheet export
  parsed at runtime, keyed by the English string, matched case-insensitively, with the key itself as
  the fallback. Adding a language is adding a column.
- **Units are display-only.** The machine and the middleware always speak Celsius on the wire;
  Fahrenheit exists in the render layer and is never persisted or transmitted.
- **Capability gating off a model string.** There is no capability endpoint, so Bengle-only features
  key off the model string from `GET /machine/info`. It's ugly, it's documented, and it's honest.

---

## Conventions

- **Comments carry the *why*,** often at length, and frequently document a bug the code's shape
  exists to prevent. Don't strip them when refactoring; extend them when the reasoning changes.
- A `ponytail:` comment marks a **deliberate** simplification and names its ceiling and upgrade path.
- **`app.css` is pre-built Tailwind output committed to the repo.** An arbitrary utility whose value
  isn't already in that bundle (`w-[420px]`, `text-[var(--my-var)]`) compiles to *nothing* and
  silently does nothing. Add styles by hand in `main.css` or a per-feature stylesheet.
- Logging goes through `logger.js` (`logger.debug` is a no-op unless debug is enabled).
- `src/vendor/*`, `plotly-*.min.js` and `reconnecting-websocket.js` are vendored — don't hand-edit.

---

## The middleware

Decaid (previously REA → ReaPrime → Streamline Bridge) is the authority on every API this skin calls.
Internal identifiers deliberately kept the old names, which is why this codebase says `rea` in code
and "Decaid" in prose.

| Port | Serves |
|---|---|
| 8080 | REST (`/api/v1/…`) and WebSockets (`/ws/v1/…`) |
| 3000 | Installed skins |
| 4001 | Interactive API docs |

Its `doc/Skins.md` is the single most useful reference for skin development; `doc/Profiles.md`,
`doc/DeviceManagement.md` and `doc/Plugins.md` cover the rest. CORS is open by default, so a skin
served from any origin can talk to the gateway.

`GET /api/v1/webui/skin-assets/{skinId}/{path}` serves raw files out of any *installed* skin — the
supported way to share icons, fonts or components between skins instead of duplicating them.

---

## Releasing

`.github/workflows/release.yml` handles both paths:

- **Push to `main`** → the whitelisted files are published to the `dist` branch, with the manifest id
  suffixed (`msl-dist`) so a dev build installs *alongside* the released skin rather than over it.
- **Push a `v*` tag** → the same tree is zipped and published as a GitHub Release, with the version
  rewritten from the tag so the tag is the single source of truth.

The whitelist is `index.html`, `skin-manifest.json` and `src/` — everything else (docs, tests, CI) is
excluded by construction rather than by ignore rules. `skin-manifest.json` must sit at the **zip
root**; Decaid reads it there to identify the skin.

**Bump `src/version.js` (`APP_VERSION`) and `skin-manifest.json` `version` together.** The settings
page compares them to decide whether to show "reload to apply", and a mismatch shows a permanent
false update badge. Versions must be **numeric dot-segments** — both sides parse them as numbers, so
anything carrying a product name degrades silently.

---

## License

Copyright (C) MSL contributors.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

The full text is in [LICENSE](LICENSE) (GPL-3.0-or-later). Vendored third-party code under
`src/vendor/` and the bundled Plotly build keep their own licenses.
