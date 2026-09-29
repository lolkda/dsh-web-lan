import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

// Reintroducing an exact version or an upper bound must fail these tests.
// This checks admission metadata, not compatibility with future DSH APIs.
test('DSH peer declaration does not restrict runtime versions', () => {
	assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '*');
	assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh'].optional, true);
});

test('bundle compatibility metadata does not restrict DSH versions', () => {
	assert.equal(manifest.dsh.compatibility.dsh, '*');
	assert.deepEqual(manifest.dsh.compatibility.profiles, ['web']);
});

test('lockfile preserves the published DSH peer declaration', () => {
	assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
	assert.deepEqual(lock.packages[''].peerDependenciesMeta, manifest.peerDependenciesMeta);
});
