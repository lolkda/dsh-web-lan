import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { planRelease } from '../scripts/release.mjs';

const run = promisify(execFile);

/** Shape of a plan, so each assertion only names the field under test. */
function plan(overrides = {}) {
	return planRelease({ version: '0.2.0-rc.1', tag: 'v0.2.0-rc.1', published: [], ...overrides });
}

// npm refuses `npm publish` on a prerelease unless a dist-tag is passed
// (npm >= 11: "You must specify a tag using --tag when publishing a prerelease
// version."), and an rc must never be reachable through `latest`. So the
// dist-tag is derived from the version instead of left to npm's default.
test('gives a prerelease version the next dist-tag', () => {
	assert.equal(plan({ version: '0.2.0-rc.1', tag: 'v0.2.0-rc.1' }).npmTag, 'next');
});

test('gives a stable version the latest dist-tag', () => {
	assert.equal(plan({ version: '0.1.1', tag: 'v0.1.1' }).npmTag, 'latest');
});

test('rejects a tag that does not match the package version', () => {
	assert.throws(() => plan({ version: '0.2.0-rc.1', tag: 'v0.2.0' }), /does not match/);
});

test('rejects a version that is already published', () => {
	assert.throws(() => plan({ published: ['0.1.0', '0.2.0-rc.1'] }), /already published/);
});

test('accepts a manual run without a tag', () => {
	assert.equal(plan({ tag: undefined }).npmTag, 'next');
});

test('prints the GITHUB_OUTPUT line for the workflow', async () => {
	const { stdout } = await run(process.execPath, [
		'scripts/release.mjs',
		'--version', '0.2.0-rc.1',
		'--tag', 'v0.2.0-rc.1',
		'--published', '["0.1.0","0.1.1"]'
	]);
	assert.equal(stdout.trim(), 'npm-tag=next');
});

// `npm view <pkg> versions --json` returns a bare string, not an array, while a
// package has exactly one published version. The workflow pipes that straight
// through, so the CLI must read it as a one-element list.
test('reads a single published version from npm view as a list', async () => {
	await assert.rejects(
		run(process.execPath, ['scripts/release.mjs', '--version', '0.1.0', '--published', '"0.1.0"']),
		/already published/
	);
});

test('exits non-zero with an ::error:: annotation when a gate fails', async () => {
	await assert.rejects(
		run(process.execPath, ['scripts/release.mjs', '--version', '0.2.0-rc.1', '--tag', 'v0.2.0']),
		(error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /^::error::.*does not match/m);
			return true;
		}
	);
});