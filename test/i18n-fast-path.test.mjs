// i18n used to parse all 32 columns of a 1.5 MB sheet at every boot and throw
// 31 of them away. It now scans one column (i18n-parser.js) and caches the
// result. Two things have to hold for that to be safe: the pinned language list
// must still match the sheet, and the cheap parser must produce the same table
// the old whole-sheet parser did — a quoting difference here would silently
// corrupt every translated string in the UI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SUPPORTED_LANGUAGES, parseTranslationColumn } from '../src/modules/i18n-parser.js';

const csvUrl = new URL('../src/ui/de1 gui translation - Sheet1.csv', import.meta.url);

test('the cheap language list matches the translation sheet header', () => {
    const csv = readFileSync(csvUrl, 'utf8');
    const header = csv.replace(/^﻿/, '').split(/\r?\n/, 1)[0].split(',').map(value => value.trim());
    assert.deepEqual(SUPPORTED_LANGUAGES, header);
});

test('the parser retains only the requested column and handles quoted CSV values', () => {
    const csv = '﻿en,de,fr\nHello,Hallo,Bonjour\n"With, comma","Mit, Komma","Avec, virgule"\n"Quote ""here""","Zitat ""hier""","Citation"\nFallback,,Repli';
    const { table, keyIndex } = parseTranslationColumn(csv, 'de');
    assert.deepEqual(table, {
        Hello: 'Hallo',
        'With, comma': 'Mit, Komma',
        'Quote "here"': 'Zitat "hier"',
        Fallback: 'Fallback',
    });
    assert.equal(keyIndex['with, comma'], 'With, comma');
    assert.equal(JSON.stringify(table).includes('Bonjour'), false);
});

test('an unknown column is an error, not a silently empty table', () => {
    assert.throws(() => parseTranslationColumn('en,de\nHello,Hallo', 'klingon'), /Translation column not found/);
});

// ---------------------------------------------------------------------------
// The parser this replaced, verbatim, as the reference implementation.
function legacyParseCSV(csvText) {
    if (csvText.charCodeAt(0) === 0xFEFF) {
        csvText = csvText.substring(1);
    }
    const lines = csvText.trim().split(/\r?\n/);
    const headers = lines[0].split(',').map(h => h.trim());
    const translations = {};
    headers.forEach(lang => { translations[lang] = {}; });

    const splitRegex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const values = line.split(splitRegex).map(val => {
            let value = val.trim();
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1).replace(/""/g, '"');
            }
            return value;
        });
        const key = values[0];
        if (key) {
            headers.forEach((lang, index) => {
                if (values[index] !== undefined) {
                    translations[lang][key] = values[index] || values[0] || key;
                }
            });
        }
    }
    return translations;
}

test('the one-column parser reproduces the old whole-sheet parser, for every language', () => {
    const csv = readFileSync(csvUrl, 'utf8');
    const legacy = legacyParseCSV(csv);

    // The sheet carries a handful of cells with an embedded newline. Neither
    // parser handles those (both split on newlines before splitting on commas)
    // and they garble the fragments differently, so restrict the comparison to
    // well-formed records: balanced quotes and a full set of 32 columns under
    // the old splitter. That is every row either parser was ever right about.
    const splitRegex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
    const rows = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
    const columnCount = rows[0].split(',').length;
    const wellFormedKeys = new Set();
    for (const line of rows.slice(1)) {
        if (!line) continue;
        if ((line.match(/"/g) || []).length % 2 !== 0) continue;
        const values = line.split(splitRegex);
        if (values.length !== columnCount) continue;
        let key = values[0].trim();
        if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1).replace(/""/g, '"');
        if (key) wellFormedKeys.add(key);
    }
    assert.equal(columnCount, SUPPORTED_LANGUAGES.length);
    assert.ok(wellFormedKeys.size > 1800, `expected the sheet to still have its rows, got ${wellFormedKeys.size}`);

    let compared = 0;
    for (const language of SUPPORTED_LANGUAGES) {
        const { table } = parseTranslationColumn(csv, language);
        const legacyTable = legacy[language];
        for (const key of wellFormedKeys) {
            if (!(key in legacyTable)) continue;
            // Trim order is the one deliberate difference: the old parser
            // trimmed the raw cell and *then* stripped the surrounding quotes,
            // so whitespace inside the quotes survived into both keys and
            // values; the new one unquotes as it scans and trims after. So a
            // legacy entry either matches exactly, or matches once trimmed —
            // and when the key itself carried inner whitespace it now lands
            // under the trimmed key instead.
            const expected = legacyTable[key].trim();
            const actual = key in table ? table[key] : table[key.trim()];
            assert.equal(actual, expected, `${language}: ${JSON.stringify(key.slice(0, 60))}`);
            compared += 1;
        }
    }
    // 32 languages x ~1870 keys — guards against the loop silently comparing nothing.
    assert.ok(compared > 55000, `expected to compare the whole sheet, compared ${compared}`);
});

test('selecting English does not request the translation sheet', async () => {
    const fetchCalls = [];
    globalThis.fetch = (...args) => {
        fetchCalls.push(args);
        throw new Error('English must not fetch translations');
    };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.CustomEvent ??= class CustomEvent {
        constructor(type, options) {
            this.type = type;
            this.detail = options?.detail;
        }
    };
    globalThis.document = {
        body: { appendChild() {} },
        fonts: { status: 'loaded' },
        createElement: () => ({ style: {} }),
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener() {},
        dispatchEvent() {},
    };

    const { setLanguage } = await import(`../src/modules/i18n.js?english-fast-path=${Date.now()}`);
    assert.equal(await setLanguage('en'), 'en');
    assert.equal(fetchCalls.length, 0);
});
