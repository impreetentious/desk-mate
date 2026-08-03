/**
 * The single in-source copy of the release version.
 *
 * `scripts/check-version-coherence.mjs` asserts this stays equal to
 * `package.json`, the lockfile root, the README marker, and the CLI package,
 * which ship in lockstep. `npm run check:version` runs it.
 */
export const DESKMATE_VERSION = "0.12.9";
