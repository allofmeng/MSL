import { logger } from './logger.js';

// `qrcodegen` is a vendored global (src/vendor/qrcodegen.js, classic <script>,
// not a module) — see that file's header for provenance. Not imported: a
// plain <script> global is visible to modules the same way ReconnectingWebSocket
// and EasyMDE are used elsewhere in this codebase.

const QR_MODULE_PX = 8;   // rendered pixel size per QR module (square)
const QR_QUIET_ZONE = 4;  // modules of white border — the QR spec's minimum

function renderQrToCanvas(qr, canvas) {
    const modules = qr.size + QR_QUIET_ZONE * 2;
    canvas.width = modules * QR_MODULE_PX;
    canvas.height = modules * QR_MODULE_PX;
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

function encodeAsQr(obj) {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(obj)));
    // LOW ecc maximizes the byte capacity (~2953B at version 40) — this is a
    // size-constrained use case, not a print-on-a-poster one, so we don't
    // spend capacity on error correction the way a typical QR would.
    return qrcodegen.QrCode.encodeBinary(bytes, qrcodegen.QrCode.Ecc.LOW);
}

// Profile JSON regularly exceeds what a QR code can hold (max ~2953 bytes in
// byte mode). `notes` is almost always the biggest single field and is not
// needed to actually run the profile, so it's the first and only thing this
// drops before giving up. Returns { qr, notesDropped } or null if even the
// trimmed profile doesn't fit.
function buildProfileQr(profile) {
    try {
        return { qr: encodeAsQr(profile), notesDropped: false };
    } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        if (!profile.notes) return null;
        try {
            const { notes, ...trimmed } = profile;
            return { qr: encodeAsQr(trimmed), notesDropped: true };
        } catch (e2) {
            if (e2 instanceof RangeError) return null;
            throw e2;
        }
    }
}

export function showProfileQrModal(profile) {
    const modal = document.getElementById('qr-share-modal');
    const canvas = document.getElementById('qr-share-canvas');
    const warningEl = document.getElementById('qr-share-warning');
    const tooBigEl = document.getElementById('qr-share-too-big');
    if (!modal || !canvas) {
        logger.error('QR share modal markup not found.');
        return;
    }

    const result = buildProfileQr(profile);
    if (!result) {
        canvas.style.display = 'none';
        if (warningEl) warningEl.style.display = 'none';
        if (tooBigEl) tooBigEl.style.display = '';
        modal.showModal();
        return;
    }

    canvas.style.display = '';
    if (tooBigEl) tooBigEl.style.display = 'none';
    if (warningEl) warningEl.style.display = result.notesDropped ? '' : 'none';
    renderQrToCanvas(result.qr, canvas);
    modal.showModal();
}

export function initQrShareModal() {
    const closeBtn = document.getElementById('qr-share-modal-close');
    const modal = document.getElementById('qr-share-modal');
    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => modal.close());
    }
}
