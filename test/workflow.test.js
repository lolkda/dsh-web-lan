import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import yaml from 'js-yaml';

const doc = yaml.load(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'));
const steps = doc.jobs.publish.steps;
const index = (name) => steps.findIndex((step) => step.name === name);

test('the publish workflow keeps provenance out of private-repository publishes', () => {
	const publish = steps.find((step) => step.name === 'Publish');
	assert.ok(publish, 'Publish step is missing');
	// npm rejects a provenance bundle from a private source repository with E422, so the
	// flag is conditional on repository visibility instead of unconditional.
	assert.match(publish.env.PUBLISH_PROVENANCE, /visibility == 'public'/u);
	const flagLines = publish.run.split('\n').filter((line) => line.includes('--provenance'));
	assert.equal(flagLines.length, 1, 'expected exactly one --provenance occurrence');
	assert.match(flagLines[0], /args\+=\(--provenance\)/u, 'provenance must be appended conditionally');
	assert.match(publish.run, /npm publish "\.\/\$\{\{ steps\.pack\.outputs\.tarball \}\}" "\$\{args\[@\]\}"/u);
});

test('the publish workflow orders validation before packing and publishing', () => {
	const order = [
		'Install pnpm for DSH runtime validation',
		'Test',
		'Real Web startup on DSH 0.2.1-alpha.2',
		'Release gate',
		'Pack',
		'Publish',
		'Verify'
	].map((name) => {
		const at = index(name);
		assert.ok(at >= 0, `${name} step is missing`);
		return at;
	});
	for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], 'steps are out of order');
});
