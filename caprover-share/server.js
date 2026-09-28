#!/usr/bin/env node
// Short-link store for QR-shared profiles, plus the static receiver page.
//
// docs/share.html decodes a profile from the URL FRAGMENT, which browsers
// never send to a server -- that is what let this run as a static nginx site
// for so long. But the fragment IS the whole gzipped profile, so the link
// runs 700-2000+ characters: fine for a QR code, unusable pasted into a chat.
//
// This adds the one thing a static site cannot: POST the fragment once at
// /api/s, get back a short id, and GET /s/<id> 302s to /#<fragment>. The
// existing decoder needs no changes at all -- it only ever reads
// location.hash, and an old long-form link (.../#<fragment>) still works
// unchanged since this still serves share.html at "/".
//
// No auth, no rate limit, no expiry: anyone who can reach this app can store
// a blob and it stays forever. Acceptable for now because the store only
// ever holds a de1 profile (not sensitive) and MAX_BODY_BYTES below caps how
// much any one request can write. Add rate limiting or an eviction pass if
// it ever gets abused as a general-purpose pastebin.
//
// Stored under DATA_DIR, one file per id -- give this app a persistent
// directory in CapRover (App Configs -> Persistent Directories, mount
// "/app/data") or every deploy wipes the store and old short links 404.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 80;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATIC_FILE = path.join(__dirname, 'share.html');
const MAX_BODY_BYTES = 200 * 1024; // profiles compress to ~2KB; generous headroom
const ID_BYTES = 5; // base64url of 5 bytes ~= 7 chars
const FRAGMENT_RE = /^[A-Za-z0-9_-]+$/; // exactly the base64url alphabet toBase64Url() emits
const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

const idPath = (id) => path.join(DATA_DIR, id);

function newId() {
    for (;;) {
        const id = crypto.randomBytes(ID_BYTES).toString('base64url');
        if (!fs.existsSync(idPath(id))) return id;
    }
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
}

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://internal');

    if (req.method === 'OPTIONS') {
        send(res, 204, '', {
            ...CORS_HEADERS,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/s') {
        let body = '';
        let tooBig = false;
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY_BYTES) {
                tooBig = true;
                req.destroy();
            }
        });
        req.on('end', () => {
            if (tooBig) return;
            const fragment = body.trim();
            if (!FRAGMENT_RE.test(fragment)) {
                send(res, 400, 'bad fragment', CORS_HEADERS);
                return;
            }
            const id = newId();
            fs.writeFileSync(idPath(id), fragment);
            send(res, 200, id, CORS_HEADERS);
        });
        req.on('error', () => {});
        return;
    }

    if (req.method === 'GET' && pathname.startsWith('/s/')) {
        const id = pathname.slice(3);
        if (!ID_RE.test(id)) { send(res, 404, 'not found'); return; }
        fs.readFile(idPath(id), 'utf8', (err, fragment) => {
            if (err) { send(res, 404, 'not found'); return; }
            res.writeHead(302, { Location: `/#${fragment}` });
            res.end();
        });
        return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        fs.readFile(STATIC_FILE, (err, html) => {
            if (err) { send(res, 500, 'server error'); return; }
            // The decoder must never be stale: a cached old copy would fail to
            // read links a newer sender produces. The file is a few KB, so
            // revalidating every load costs nothing.
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(html);
        });
        return;
    }

    send(res, 404, 'not found');
});

server.listen(PORT, () => console.log(`listening on :${PORT}`));
