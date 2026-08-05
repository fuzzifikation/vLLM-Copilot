#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES.txt from the licenses of the production
 * (runtime) dependencies actually shipped in the VSIX.
 *
 * The VS Code Marketplace requires redistributed OSS to include license
 * notices. Run `npm run license:notices` after dependency changes and commit
 * the generated file.
 *
 * Uses the same license-checker-rseidelsohn library as `npm run license:check`,
 * scoped to --production so dev-only tooling (vitest, typescript, ...) is
 * excluded — it never ships in the VSIX.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init as licenseCheckerInit } from 'license-checker-rseidelsohn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'THIRD-PARTY-NOTICES.txt');

licenseCheckerInit(
	{
		start: root,
		production: true, // only runtime deps (what actually ships)
		excludePrivatePackages: true,
		customFormat: {
			name: true,
			version: true,
			licenses: true,
			repository: true,
			licenseText: false, // pulled from the license file separately below
		},
	},
	(err, packages) => {
		if (err) {
			console.error('Failed to scan licenses:', err.message);
			process.exit(1);
		}

		const entries = Object.entries(packages)
			.filter(([name]) => !name.startsWith('vllm-copilot@')) // our own package
			.sort(([a], [b]) => a.localeCompare(b));

		const lines = [];
		lines.push('vLLM-Copilot');
		lines.push('Third-party notices');
		lines.push('='.repeat(40));
		lines.push('');
		lines.push(
			'This product includes the following third-party software. Each package'
		);
		lines.push('is distributed under its own license, reproduced below.');
		lines.push('');

		for (const [name, pkg] of entries) {
			lines.push('--------------------------------------------------');
			lines.push(`${name}`);
			lines.push(`License: ${pkg.licenses || 'UNKNOWN'}`);
			if (pkg.repository) lines.push(`Repository: ${pkg.repository}`);
			lines.push('');

			const licensePath = pkg.licenseFile;
			if (licensePath && fs.existsSync(licensePath)) {
				const text = fs
					.readFileSync(licensePath, 'utf8')
					.trim()
					.replace(/\r\n/g, '\n');
				lines.push(text);
				lines.push('');
			} else {
				lines.push('(license text not available)');
				lines.push('');
			}
		}

		fs.writeFileSync(outFile, lines.join('\n'));
		console.log(`Wrote ${outFile} (${entries.length} packages)`);
	}
);
