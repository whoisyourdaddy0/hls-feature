/*
 * Sets up the browser/compile-time globals that hls.js sources expect, before
 * any hls.js module is imported. Kept in its own module so ES module import
 * hoisting cannot run hls.js code before the flags are defined.
 */

(globalThis as any).__VERSION__ = 'abr-sim';
(globalThis as any).__USE_SUBTITLES__ = true;
(globalThis as any).__USE_ALT_AUDIO__ = true;
(globalThis as any).__USE_EME_DRM__ = true;
(globalThis as any).__USE_CMCD__ = true;
(globalThis as any).__USE_CONTENT_STEERING__ = true;
(globalThis as any).__USE_VARIABLE_SUBSTITUTION__ = true;
(globalThis as any).__USE_M2TS_ADVANCED_CODECS__ = true;
// Disable MediaCapabilities code paths (no navigator in Node).
(globalThis as any).__USE_MEDIA_CAPABILITIES__ = false;
// hls.js accesses global browser APIs through `self`.
(globalThis as any).self = globalThis;

export {};
