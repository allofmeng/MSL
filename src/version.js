// Version baked into the running bundle. Compared against the on-disk skin version
// (GET /webui/skins/{id}) to detect that Decaid has downloaded a newer skin in the
// background — a mismatch means "reload to apply".
//
// Numeric-only on purpose: settings.js compareVersions() parses this per
// dot-segment with parseInt, and Decaid's own updaters use semver parsing. A
// version string carrying the product name ("MSLv0.0.1") degrades to [0,0,1] by
// accident today and breaks the moment either side gets stricter. The product
// name lives in skin-manifest.json's `name`, which is what is shown beside it.
//
// BUMP THIS when cutting a release, in the same step as pushing the git tag —
// and keep it equal to skin-manifest.json's `version`.
export const APP_VERSION = '0.0.2';

// Our skin id as registered with Decaid (matches skin-manifest.json `id` /
// reaMetadata.skinId). Decaid keys installed skins by this string: changing it
// makes Decaid treat this as a different skin and install it alongside the old
// one, so it is not a cosmetic field.
export const SKIN_ID = 'msl';
