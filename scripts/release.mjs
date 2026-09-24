#!/usr/bin/env node
// Release gate for `npm publish`, kept out of YAML so it can be tested.
//
// The dist-tag is derived from the version instead of left to npm's default:
// npm >= 11 refuses to publish a prerelease without `--tag`, and letting an
// `-rc.N` build move `latest` would ship an unreleased build to every
// `dsh plugin add @lolkda/dsh-web-lan` user.
//
//   node scripts/release.mjs --version 0.2.0-rc.1 --tag v0.2.0-rc.1 \
//     --published '["0.1.0","0.1.1"]' >> "$GITHUB_OUTPUT"   # prints npm-tag=next

import process from 'node:process';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** @returns {{version: string, tag: string|undefined, npmTag: 'latest'|'next'}} */
export function planRelease({ version, tag, published = [] }) {
	const match = typeof version === 'string' ? SEMVER.exec(version) : null;
	if (!match) throw new Error(`invalid version "${version}"`);

	if (tag !== undefined && tag !== null && tag !== '') {
		const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag;
		if (tagVersion !== version) {
			throw new Error(`tag v${tagVersion} does not match package.json version ${version}`);
		}
	}

	if (published.includes(version)) {
		throw new Error(`${version} is already published — bump the version and re-tag`);
	}

	return { version, tag, npmTag: match[4] ? 'next' : 'latest' };
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag.startsWith('--')) throw new Error(`unexpected argument "${flag}"`);
		if (value === undefined) throw new Error(`${flag} needs a value`);
		args[flag.slice(2)] = value;
		i += 1;
	}
	return args;
}

function main(argv) {
	const args = parseArgs(argv);
	let published = [];
	if (args.published !== undefined) {
		const parsed = JSON.parse(args.published);
		// `npm view <pkg> versions --json` yields a bare string while exactly one
		// version is published, and an array from two versions on.
		published = Array.isArray(parsed) ? parsed : [parsed];
		if (published.some((entry) => typeof entry !== 'string')) {
			throw new Error('--published must be a version string or a JSON array of them');
		}
	}
	const { npmTag } = planRelease({ version: args.version, tag: args.tag, published });
	process.stdout.write(`npm-tag=${npmTag}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`::error::${error.message}\n`);
		process.exit(1);
	}
}