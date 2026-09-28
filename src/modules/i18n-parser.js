// Pure CSV helpers for i18n.js — no DOM, no fetch, no storage, so the parsing
// path stays unit-testable (test/i18n-fast-path.test.mjs).
//
// `src/ui/de1 gui translation - Sheet1.csv` is ~1.5 MB with 32 language
// columns. The previous parser split every row with a lookahead regex and built
// a table for ALL 32 columns, then used one — ~31/32 of that work was thrown
// away, on the critical path of every boot (and every reload after Decaid's
// 10-minute background unload). parseTranslationColumn() scans a single column
// with a character loop instead, and i18n.js caches the result in IndexedDB.

// The language list used to be read off the CSV header row at runtime, which
// meant the 1.5 MB sheet had to be parsed before the language switcher could be
// populated. It is now pinned here: **edit this list whenever a column is added
// to or removed from the sheet**, or the new language silently never appears in
// the switcher. test/i18n-fast-path.test.mjs asserts the two stay in sync.
export const SUPPORTED_LANGUAGES = Object.freeze([
    'en', 'fr', 'es', 'de', 'de-ch', 'zh-hans', 'zh-hant', 'kr', 'pt', 'ar', 'arb', 'he', 'heb', 'da', 'sv', 'no',
    'it', 'nl', 'jp-unfinished', 'th-unfinished', 'hu-unfinished', 'pl-unfinished', 'sk-unfinished', 'el-unfinished',
    'cs-unfinished', 'ro-unfinished', 'hi-unfinished', 'tr-unfinished', 'ru-unfinished', 'de-oe unfinished',
    'ca-unfinished', 'fi-unfinished',
]);

// Reads column 0 (the English key) and one target column out of a CSV line,
// stopping as soon as both are known. RFC-4180 quoting: "" inside a quoted
// field is a literal quote, commas inside quotes are not separators.
function selectedValues(line, targetColumn) {
    let column = 0;
    let quoted = false;
    let value = '';
    let key = '';
    let translation = '';

    const commit = () => {
        const normalized = value.trim();
        if (column === 0) key = normalized;
        if (column === targetColumn) translation = normalized;
        column += 1;
        value = '';
    };

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' && quoted && line[index + 1] === '"') {
            value += '"';
            index += 1;
        } else if (character === '"') {
            quoted = !quoted;
        } else if (character === ',' && !quoted) {
            commit();
            if (column > targetColumn) break;
        } else {
            value += character;
        }
    }
    if (column <= targetColumn) commit();
    return [key, translation];
}

/**
 * Builds the translation table for ONE language.
 * @param {string} csvText The whole sheet.
 * @param {string} language A column name from SUPPORTED_LANGUAGES.
 * @returns {{table: Object<string,string>, keyIndex: Object<string,string>}}
 *   `table` maps the English key to its translation (falling back to the key
 *   when the cell is empty); `keyIndex` maps a lowercased key to the canonical
 *   one so lookups tolerate UI/sheet casing differences.
 */
export function parseTranslationColumn(csvText, language) {
    const normalizedText = csvText.charCodeAt(0) === 0xFEFF ? csvText.slice(1) : csvText;
    const lines = normalizedText.split(/\r?\n/);
    const headers = lines[0].split(',').map(header => header.trim());
    const targetColumn = headers.indexOf(language);
    if (targetColumn < 0) throw new Error(`Translation column not found: ${language}`);

    const table = {};
    const keyIndex = {};
    for (let index = 1; index < lines.length; index += 1) {
        if (!lines[index]) continue;
        const [key, translation] = selectedValues(lines[index], targetColumn);
        if (!key) continue;
        table[key] = translation || key;
        keyIndex[key.toLowerCase()] = key;
    }
    return { table, keyIndex };
}
