/**
 * Builds the staging copy VSCE packages from: ROOT minus SKIP, runtime
 * dependencies in, MIT license at the stage root, prepublish hook removed.
 * Sidecar declaration for scripts/package-vsix.mjs, which test/packageStaging
 * .test.ts imports to ask VSCE about the exact tree that ships.
 */
export function stageForVsce(rootDir: string, stageDir: string): void;
