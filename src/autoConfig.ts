/**
 * Stable root facade (refactor-plan §2.0). All logic lives in src/commands/*;
 * this file only re-exports the command registrations and the BYOK helper so
 * that extension.ts keeps a single stable import surface. No business logic
 * lives here — it is a thin command-registration facade.
 */
export { registerAddServerModelCommand } from './commands/addServerFlow.js';
export { registerAutoConfigureModelCommand } from './commands/autoConfigureFlow.js';
export { ensureByokUtilityDefault, registerConfigureUtilityModelCommand } from './commands/byok.js';
