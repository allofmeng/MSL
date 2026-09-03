const noop = () => {};

export const logger = {
    debug: noop, // Start with a no-op function for debug
    // Also a no-op: the info calls on the boot path (i18n, idb, sockets) cost
    // real time on a tablet's console, and nothing reads them in production.
    // Flip to console.info temporarily when tracing a startup problem.
    info: noop,
    warn: console.warn.bind(console, '[WARN]'),
    error: console.error.bind(console, '[ERROR]'),
};

export function setDebug(enabled) {
    if (enabled) {
        // When debugging is on, point logger.debug to a bound console.log
        logger.debug = console.log.bind(console, '[DEBUG]');
    } else {
        // When it's off, point it back to the function that does nothing
        logger.debug = noop;
    }
}
