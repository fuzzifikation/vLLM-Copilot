#!/usr/bin/env node
/**
 * Copies the Choices.js dist (searchable model picker in the Model Settings
 * webview) from node_modules into resources/, where the webview loads it via
 * asWebviewUri (the webview CSP allows no CDN). Run `npm run vendor:choices`
 * after bumping the choices.js devDependency and commit the copies;
 * THIRD-PARTY-NOTICES.txt carries the license (`npm run license:notices`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'node_modules', 'choices.js');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

const copies = [
  ['public/assets/scripts/choices.min.js', 'resources/choices.min.js'],
  ['public/assets/styles/choices.min.css', 'resources/choices.min.css'],
];
for (const [from, to] of copies) {
  fs.copyFileSync(path.join(pkgDir, from), path.join(root, to));
  console.log(`vendored ${to} (choices.js ${pkg.version})`);
}
