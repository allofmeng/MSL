import { logger } from './logger.js';

// Share a profile as a QR code.
//
// The QR carries a URL whose FRAGMENT is the profile itself, gzipped and
// base64url'd: `https://…/share.html#H4sIA…`. Two consequences worth stating,
// because they are the whole reason for this shape:
//
//   - A phone's camera app opens a link. It can do nothing with raw JSON, which
//     is what an earlier version of this file encoded — that produced a wall of
//     text on the scanner and nothing else.
//   - A fragment is never sent to the server, so the receiving page is a static
//     decoder (docs/share.html, published to GitHub Pages). No upload service,
//     no token on this tablet, nothing stored anywhere.
//
// Profiles compress hard — every profile bundled with this skin lands between
// 448 and 1992 bytes against a 2953-byte QR budget — so the payload fits with
// room to spare. `notes` is dropped only if a particular profile overruns.
//
// `qrcodegen` is a vendored global (src/vendor/qrcodegen.js, classic <script>,
// not a module) — see that file's header for provenance. Not imported: a
// plain <script> global is visible to modules the same way ReconnectingWebSocket
// and EasyMDE are used elsewhere in this codebase.

// Receiver page. Must stay in step with where docs/share.html is published —
// GitHub Pages serves it from /docs on main.
export const SHARE_BASE_URL = 'https://allofmeng.github.io/MSL/share.html';

// QR byte mode at LOW ecc tops out at 2953 bytes. qrcodegen raises the error
// correction for free when the data leaves room, so LOW is a floor on quality,
// not a ceiling.
const QR_BYTE_CAPACITY = 2953;

const QR_QUIET_ZONE = 4;  // modules of white border — the QR spec's minimum
// Backing-store pixels per module. The canvas is scaled to a fixed CSS size, so
// this controls crispness, not how large the code appears on screen.
const QR_MODULE_PX = 8;

// On-screen pixels per module. A phone camera needs roughly 3 to reliably
// resolve one, and a full profile runs to 149 modules plus the quiet zone — at
// the old fixed 320px that was 2.0 per module, which is where scans fail.
const QR_DISPLAY_PX_PER_MODULE = 4;
const QR_DISPLAY_MIN = 320;
const QR_DISPLAY_MAX = 620;   // fits the tablet's 800px-tall design canvas

function renderQrToCanvas(qr, canvas) {
    const modules = qr.size + QR_QUIET_ZONE * 2;
    canvas.width = modules * QR_MODULE_PX;
    canvas.height = modules * QR_MODULE_PX;
    // Sized by module count, not fixed: a small profile stays compact and a
    // dense one grows instead of becoming unscannable.
    const display = Math.min(QR_DISPLAY_MAX, Math.max(QR_DISPLAY_MIN, modules * QR_DISPLAY_PX_PER_MODULE));
    canvas.style.width = `${display}px`;
    canvas.style.height = `${display}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (qr.getModule(x, y)) {
                ctx.fillRect((x + QR_QUIET_ZONE) * QR_MODULE_PX, (y + QR_QUIET_ZONE) * QR_MODULE_PX, QR_MODULE_PX, QR_MODULE_PX);
            }
        }
    }
}

function toBase64Url(bytes) {
    let binary = '';
    // Chunked so a large profile cannot reach the argument-count limit of
    // String.fromCharCode.apply.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// gzip where the platform has it, plain UTF-8 otherwise. The receiver sniffs the
// gzip magic bytes and handles both, so a WebView without CompressionStream
// still produces a working link — just a longer one.
async function encodeBody(text) {
    const raw = new TextEncoder().encode(text);
    if (typeof CompressionStream !== 'function') {
        logger.warn('CompressionStream unavailable — sharing an uncompressed profile.');
        return raw;
    }
    try {
        const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
        logger.warn('gzip failed, sharing uncompressed:', e);
        return raw;
    }
}

/**
 * Build the share URL for a profile.
 * @returns {Promise<{url: string, notesDropped: boolean}|null>} null when even
 *          the trimmed profile will not fit in a QR code.
 */
export async function buildShareUrl(profile) {
    const attempt = async (body) => {
        const url = `${SHARE_BASE_URL}#${toBase64Url(await encodeBody(JSON.stringify(body)))}`;
        return url.length <= QR_BYTE_CAPACITY ? url : null;
    };

    const full = await attempt(profile);
    if (full) return { url: full, notesDropped: false };

    // Notes are the one field that is usually large and never needed to pull the
    // shot, so they are the only thing dropped before giving up.
    if (!profile.notes) return null;
    const { notes, ...trimmed } = profile;
    const short = await attempt(trimmed);
    return short ? { url: short, notesDropped: true } : null;
}

export async function showProfileQrModal(profile) {
    const modal = document.getElementById('qr-share-modal');
    const canvas = document.getElementById('qr-share-canvas');
    const warningEl = document.getElementById('qr-share-warning');
    const tooBigEl = document.getElementById('qr-share-too-big');
    const urlEl = document.getElementById('qr-share-url');
    if (!modal || !canvas) {
        logger.error('QR share modal markup not found.');
        return;
    }

    const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };

    let result = null;
    try {
        result = await buildShareUrl(profile);
    } catch (e) {
        logger.error('Could not build the share link:', e);
    }

    if (!result) {
        show(canvas, false);
        show(warningEl, false);
        show(urlEl, false);
        show(tooBigEl, true);
        modal.showModal();
        return;
    }

    show(canvas, true);
    show(tooBigEl, false);
    show(warningEl, result.notesDropped);
    if (urlEl) {
        // The link as text as well as in the code: a camera that will not focus,
        // a scratched screen, or a scanner that mangles a long URL all leave the
        // user something they can read out or copy.
        urlEl.textContent = result.url;
        show(urlEl, true);
    }
    try {
        // Throws if the vendored global is missing (a stale index.html) rather
        // than leaving an empty white square with no explanation.
        renderQrToCanvas(qrcodegen.QrCode.encodeText(result.url, qrcodegen.QrCode.Ecc.LOW), canvas);
    } catch (e) {
        logger.error('Could not draw the QR code:', e);
        show(canvas, false);
    }
    modal.showModal();
}

export function initQrShareModal() {
    const closeBtn = document.getElementById('qr-share-modal-close');
    const modal = document.getElementById('qr-share-modal');
    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => modal.close());
    }
}
