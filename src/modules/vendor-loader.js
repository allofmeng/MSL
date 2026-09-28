// On-demand loading for the vendored third-party globals that used to sit in
// index.html as blocking <script> tags.
//
// Why: index.html loaded plotly (4.7 MB), easymde (320 KB), qrcodegen (45 KB)
// and iro (28 KB) synchronously in <head>, so ~5 MB had to be fetched, parsed
// and executed before the first pixel of the dashboard. On the tablet WebView
// this is the single biggest cost at boot — and Decaid reloads the skin from
// scratch every time the app has been backgrounded for 10 minutes, so it is a
// cost the user pays repeatedly, not once. Three of the four are only needed by
// UI the user may never open (notes editor, LED colour wheel, QR share).
//
// These are classic scripts that define a window global — not ES modules — so
// they are injected as <script> and awaited via onload, and the loader resolves
// with the global. Each path is loaded at most once: repeat calls get the same
// promise, and a call made after the script is already in gets a resolved one.
//
// Nothing here has a build step or a CDN: the files are the same vendored
// copies, served from the same origin, just fetched when they are wanted.

const loads = new Map();

function loadElement(tagName, path) {
    if (loads.has(path)) return loads.get(path);
    const promise = new Promise((resolve, reject) => {
        const element = document.createElement(tagName);
        if (tagName === 'script') {
            element.src = path;
            element.async = true;
        } else {
            element.rel = 'stylesheet';
            element.href = path;
        }
        element.onload = () => resolve(element);
        element.onerror = () => {
            element.remove();
            reject(new Error(`Failed to load ${path}`));
        };
        document.head.appendChild(element);
    }).catch(error => {
        // Drop the rejected promise so a later attempt can retry rather than
        // inheriting the failure forever (a flaky first fetch at boot should not
        // permanently disable the chart).
        loads.delete(path);
        throw error;
    });
    loads.set(path, promise);
    return promise;
}

function loadScript(path, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return loadElement('script', path).then(() => {
        if (!window[globalName]) throw new Error(`${globalName} did not initialize`);
        return window[globalName];
    });
}

export function loadStyle(path) {
    return loadElement('link', path);
}

// Paths are relative to index.html, the only real document (see CLAUDE.md) —
// the router only ever splices fragments into it, never navigates away.
export function loadPlotly() {
    return loadScript('src/modules/plotly-3.1.0.min.js', 'Plotly');
}

export function loadEasyMDE() {
    return Promise.all([
        loadStyle('src/vendor/easymde.min.css'),
        loadScript('src/vendor/easymde.min.js', 'EasyMDE'),
    ]).then(([, EasyMDE]) => EasyMDE);
}

export function loadIro() {
    return loadScript('src/vendor/iro.min.js', 'iro');
}

export function loadQrCodeGen() {
    return loadScript('src/vendor/qrcodegen.js', 'qrcodegen');
}

/**
 * Run `fn` with Plotly guaranteed present.
 *
 * Once loaded — which is the steady state for everything after boot — this is a
 * single truthy test and `fn` runs SYNCHRONOUSLY, so call ordering between the
 * chart's entry points is exactly what it was when Plotly was a blocking
 * script. Only calls that land inside the initial load window are deferred, and
 * those queue in FIFO order on the one shared promise instead of being dropped.
 *
 * A load failure is reported rather than swallowed: a chart that silently never
 * draws is the failure mode this whole change has to avoid.
 */
export function whenPlotly(fn) {
    if (window.Plotly) return fn();
    return loadPlotly().then(fn).catch(error => {
        console.error('[vendor-loader] Plotly unavailable, chart draw skipped:', error);
    });
}
