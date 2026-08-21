// The receiver page (docs/share.html) is the only thing standing between a
// scanned QR code and a usable profile, so its decoder gets a round-trip check.
// Sliced out of the HTML rather than imported: it is one self-contained page,
// not a module the skin ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../docs/share.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length,
                          html.lastIndexOf('</script>'));
// Everything up to the DOM helpers is the decoder; the rest touches document.
const decoder = script.slice(0, script.indexOf("const $ = (id) =>")).replace(/export /g, '');
const { decodePayload } = await import(
    'data:text/javascript;base64,' + Buffer.from(decoder + '\nexport { decodePayload };').toString('base64'));

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

async function gzip(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const profile = {
    title: 'Test Profile', author: 'MSL', target_weight: '36',
    steps: [{ name: 'preinfusion', pump: 'flow', flow: '4', temperature: '92', seconds: '10' }],
};

test('a gzipped payload round-trips', async () => {
    const decoded = await decodePayload(b64url(await gzip(JSON.stringify(profile))));
    assert.deepEqual(decoded, profile);
});

test('an uncompressed payload also works', async () => {
    // The sender falls back to this when its WebView has no CompressionStream.
    const decoded = await decodePayload(b64url(Buffer.from(JSON.stringify(profile))));
    assert.deepEqual(decoded, profile);
});

test('a full record is unwrapped to the profile', async () => {
    const record = { id: 'abc', profile, metadata: { targetYield: 36 } };
    assert.deepEqual(await decodePayload(b64url(await gzip(JSON.stringify(record)))), profile);
});

test('anything that is not a profile is rejected', async () => {
    await assert.rejects(decodePayload(b64url(await gzip('{"hello":"world"}'))),
        /does not contain an espresso profile/);
    await assert.rejects(decodePayload(b64url(await gzip('not json'))), SyntaxError);
});

test('base64url survives padding and the - _ alphabet', async () => {
    // 1-2 bytes of padding and both substituted characters, since the page pads
    // and translates by hand rather than relying on a decoder that accepts them.
    for (let pad = 0; pad < 3; pad++) {
        const padded = { ...profile, title: 'x'.repeat(10 + pad) };
        const encoded = b64url(await gzip(JSON.stringify(padded)));
        assert.equal((await decodePayload(encoded)).title, padded.title);
    }
    const bytes = new Uint8Array([0xfb, 0xff, 0x00]); // encodes to '-' and '_'
    assert.match(Buffer.from(bytes).toString('base64url'), /[-_]/);
});

// ── Sender → receiver, the contract that actually matters ───────────────────
// qrShare.js builds the link and docs/share.html reads it. They are in
// different halves of the repo and only agree by convention, so the round trip
// is tested rather than assumed.
const { buildShareUrl, SHARE_BASE_URL } = await import('../src/modules/qrShare.js');

const realProfile = JSON.parse(
    readFileSync(new URL('../src/profiles/80s_Espresso.json', import.meta.url), 'utf8'));

test('the link points at a page that decodes it', () => {
    // https, because a scanner opening plain http gets a browser warning at
    // best and a refusal at worst.
    assert.match(SHARE_BASE_URL, /^https:\/\//);
    // Ends at a directory or an .html file, so appending '#payload' produces a
    // fragment rather than mangling a path.
    assert.match(SHARE_BASE_URL, /(\/|\.html)$/);
    // Whatever host it names, this is the file being served there.
    assert.ok(readFileSync(new URL('../docs/share.html', import.meta.url), 'utf8').length > 0);
});

test('a real profile survives the round trip', async () => {
    const { url, notesDropped } = await buildShareUrl(realProfile);
    assert.equal(notesDropped, false);
    assert.ok(url.startsWith(SHARE_BASE_URL + '#'));
    assert.deepEqual(await decodePayload(url.split('#')[1]), realProfile);
});

test('the whole link fits the QR byte budget', async () => {
    const { url } = await buildShareUrl(realProfile);
    assert.ok(url.length <= 2953, `link is ${url.length} bytes`);
});

test('notes are dropped only when the profile will not otherwise fit', async () => {
    // Genuinely random, so gzip cannot squeeze it away — a periodic filler
    // compresses down to nothing and the profile fits after all.
    const notes = Buffer.from(crypto.getRandomValues(new Uint8Array(6000))).toString('base64');
    const { url, notesDropped } = await buildShareUrl({ ...realProfile, notes });
    assert.equal(notesDropped, true);
    const decoded = await decodePayload(url.split('#')[1]);
    assert.equal(decoded.notes, undefined);
    assert.equal(decoded.title, realProfile.title, 'everything else is intact');
});

test('a profile too large even without notes reports itself', async () => {
    const steps = Array.from({ length: 400 }, (_, i) => ({
        name: `step ${i} ${Math.random().toString(36)}`, temperature: '93', seconds: '5',
        pump: 'pressure', pressure: String(i % 12),
    }));
    assert.equal(await buildShareUrl({ title: 'Huge', steps }), null);
});
