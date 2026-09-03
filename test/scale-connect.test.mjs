// A fetch rejection in connectScaleDevice used to hit `return response.json()`
// in the catch, where `response` is scoped to the try — so the caller saw a
// ReferenceError instead of the connection failure that actually happened.
//
// Sliced out of the source rather than imported: api.js opens sockets at module
// scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const match = source.match(/export async function connectScaleDevice\(\) \{[\s\S]*?\r?\n\}/);

test('scale connection preserves the original fetch failure', async () => {
    assert.ok(match, 'connectScaleDevice not found in api.js');
    const failure = new Error('offline');
    const connect = new Function('fetch', 'API_BASE_URL', 'logger', 'getScaleDeviceId',
        `${match[0].replace('export ', '')}; return connectScaleDevice;`)(
        async () => { throw failure; },
        'http://localhost',
        { info() {}, error() {}, warn() {} },
        () => 'scale-1',
    );
    await assert.rejects(connect(), error => error === failure);
});
