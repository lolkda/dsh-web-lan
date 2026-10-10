import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import Loader, { interpolate } from '@deepseek-ai/cordis-plugin-loader';
import * as yaml from 'js-yaml';
import { apply, canonicalAddress, inject, name, publishBind, resolveBindHost } from '../lib/bind.js';

/**
 * One interface fixture, with the VPN adapter enumerated FIRST: `auto` picks the
 * first non-internal IPv4 in `os.networkInterfaces()` order, and the note's
 * standing risk is that the VPN address is the one enumeration reaches first.
 * Every branch below therefore runs against injected data, never this machine's.
 */
function netFixture() {
	return {
		tun0: [{ address: '10.8.0.6', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
		lo: [
			{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true },
			{ address: '::1', family: 'IPv6', internal: true }
		],
		ens192: [
			{ address: '192.168.1.100', netmask: '255.255.255.0', family: 'IPv4', internal: false },
			{ address: '2001:db8::5', family: 'IPv6', internal: false }
		],
		sit0: [{ address: 'fe80::1', family: 'IPv6', internal: false }]
	};
}

/** A minimal stand-in for the plugin context `apply` runs in. */
function fakeCtx(webStartup) {
	const provided = {};
	const warned = [];
	const informed = [];
	return {
		provided,
		warned,
		informed,
		ctx: {
			webStartup,
			provide: (serviceName, value) => { provided[serviceName] = value; },
			logger: { warn: (message) => warned.push(message), info: (message) => informed.push(message) }
		}
	};
}

/** Run `body` with `vars` applied to `process.env` (`undefined` removes the key), then restore. */
async function withEnv(vars, body) {
	const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(vars)) if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		return await body();
	} finally {
		for (const [key, value] of saved) if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

test('exports the Cordis plugin contract', () => {
	assert.equal(name, 'web-lan-bind');
	assert.deepEqual(inject, ['webStartup']);
});

test('resolves --host, then the loopback escape, then DSH_WEB_HOST, then the first non-internal IPv4', () => {
	const interfaces = netFixture();
	assert.deepEqual(
		resolveBindHost({ startupHost: '192.168.1.100', env: { DSH_WEB_LOOPBACK: '1', DSH_WEB_HOST: '10.8.0.6' }, interfaces }),
		{ host: '192.168.1.100', source: 'cli' }
	);
	assert.deepEqual(
		resolveBindHost({ env: { DSH_WEB_LOOPBACK: '1', DSH_WEB_HOST: '10.8.0.6' }, interfaces }),
		{ host: '127.0.0.1', source: 'loopback' }
	);
	assert.deepEqual(
		resolveBindHost({ env: { DSH_WEB_HOST: '10.8.0.6' }, interfaces }),
		{ host: '10.8.0.6', source: 'env' }
	);
	// tun0 enumerates first, so that is the automatic choice — visible and
	// overridable, which is the whole reason the resolver reports its source.
	assert.deepEqual(resolveBindHost({ env: {}, interfaces }), { host: '10.8.0.6', source: 'auto' });
	// Only an absent knob is a default. A present value is always validated, so a
	// blank one stops the boot instead of quietly selecting the automatic address.
	assert.throws(
		() => resolveBindHost({ startupHost: '   ', env: {}, interfaces }),
		/not a concrete IPv4 or IPv6 address literal/u
	);
	assert.throws(() => resolveBindHost({ env: { DSH_WEB_HOST: '  ' }, interfaces }), /DSH_WEB_HOST/u);
});

test('falls back to loopback with a warning when there is no non-internal IPv4', () => {
	const resolved = resolveBindHost({
		env: {},
		interfaces: { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }
	});
	assert.equal(resolved.host, '127.0.0.1');
	assert.equal(resolved.source, 'fallback');
	assert.match(resolved.warning, /127\.0\.0\.1/u);
	// No interfaces at all is the same branch, and still never a wildcard.
	const empty = resolveBindHost({ env: {}, interfaces: {} });
	assert.equal(empty.host, '127.0.0.1');
	assert.equal(empty.source, 'fallback');
});

test('refuses a wildcard, a non-literal, and an address this machine does not own', () => {
	const interfaces = netFixture();
	for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) {
		assert.throws(() => resolveBindHost({ startupHost: host, env: {}, interfaces }), /wildcard/u, host);
		assert.throws(() => resolveBindHost({ env: { DSH_WEB_HOST: host }, interfaces }), /wildcard/u, host);
	}
	// `127.0.0.1%junk` and `0.0.0.0%1` are in this list because `node:net` reads a
	// zone on an IPv4 literal as address text, exactly as the webserver schema does.
	const notLiterals = [
		'localhost',
		'192.168.1',
		'192.168.1.256',
		'10.0.0.0/8',
		'::ffff:1.2.3',
		'127.0.0.1%junk',
		'0.0.0.0%1',
		'',
		'   ',
		' 192.168.1.100 '
	];
	for (const host of notLiterals) {
		assert.throws(
			() => resolveBindHost({ startupHost: host, env: {}, interfaces }),
			/not a concrete IPv4 or IPv6 address literal/u,
			JSON.stringify(host)
		);
		assert.throws(
			() => resolveBindHost({ env: { DSH_WEB_HOST: host }, interfaces }),
			/not a concrete IPv4 or IPv6 address literal/u,
			JSON.stringify(host)
		);
	}
	// An injected non-string is refused too: `undefined` alone means "not asked for".
	for (const host of [42, null, {}, true]) {
		assert.throws(
			() => resolveBindHost({ startupHost: host, env: {}, interfaces }),
			/not a concrete IPv4 or IPv6 address literal/u,
			String(host)
		);
	}
	assert.throws(() => resolveBindHost({ startupHost: '10.9.9.9', env: {}, interfaces }), /not an address of this machine/u);
	// The refusal names what this machine does have, so a typo is one correction away.
	assert.throws(() => resolveBindHost({ env: { DSH_WEB_HOST: '10.9.9.9' }, interfaces }), /192\.168\.1\.100/u);
	assert.throws(() => resolveBindHost({ env: { DSH_WEB_HOST: '10.9.9.9' }, interfaces }), /DSH_WEB_HOST/u);
});

test('keeps loopback and a local IPv6 literal exactly as they were written', () => {
	const interfaces = netFixture();
	// Loopback is accepted without any interface list: it is always local.
	assert.deepEqual(resolveBindHost({ startupHost: '127.0.0.1', env: {}, interfaces: {} }), { host: '127.0.0.1', source: 'cli' });
	assert.deepEqual(resolveBindHost({ startupHost: '::1', env: {}, interfaces: {} }), { host: '::1', source: 'cli' });
	const expanded = '2001:0db8:0000:0000:0000:0000:0000:0005';
	assert.deepEqual(resolveBindHost({ startupHost: expanded, env: {}, interfaces }), { host: expanded, source: 'cli' });
	// A zone selects an interface and is not part of the comparison.
	assert.deepEqual(resolveBindHost({ startupHost: 'fe80::1%ens192', env: {}, interfaces }), { host: 'fe80::1%ens192', source: 'cli' });
	// `listen` reads the mapped form as the IPv4 address, so it is that address's locality that counts.
	assert.deepEqual(
		resolveBindHost({ startupHost: '::ffff:192.168.1.100', env: {}, interfaces }),
		{ host: '::ffff:192.168.1.100', source: 'cli' }
	);
});

test('canonicalAddress folds the spellings that have to compare equal', () => {
	assert.equal(canonicalAddress('::ffff:192.168.1.100'), '192.168.1.100');
	assert.equal(canonicalAddress('2001:0db8::0005'), canonicalAddress('2001:db8:0:0:0:0:0:5'));
	assert.equal(canonicalAddress('fe80::1%ens192'), canonicalAddress('fe80::1'));
	assert.notEqual(canonicalAddress('::'), undefined);
	assert.equal(canonicalAddress('localhost'), undefined);
	assert.equal(canonicalAddress(undefined), undefined);
	// The zone is stripped only after the whole value passed `node:net`.
	assert.equal(canonicalAddress('127.0.0.1%junk'), undefined);
	assert.equal(canonicalAddress(' 127.0.0.1'), undefined);
});

test('apply reads webStartup and publishes webLanBind', async () => {
	// `apply` reads the real process environment, so pin both knobs to "unset"
	// and derive the expected address the same way a bare launch would.
	const expected = await withEnv(
		{ DSH_WEB_HOST: undefined, DSH_WEB_LOOPBACK: undefined },
		() => resolveBindHost({ env: process.env, interfaces: networkInterfaces() })
	);

	const cli = fakeCtx({ host: expected.host });
	apply(cli.ctx);
	assert.deepEqual(cli.provided, { webLanBind: { host: expected.host } });
	assert.deepEqual(cli.warned, []);
	assert.match(cli.informed[0], /listening on /u);

	const automatic = fakeCtx({});
	await withEnv({ DSH_WEB_HOST: undefined, DSH_WEB_LOOPBACK: undefined }, () => apply(automatic.ctx));
	assert.deepEqual(automatic.provided, { webLanBind: { host: expected.host } });
	assert.deepEqual(automatic.warned, expected.warning === undefined ? [] : [expected.warning]);
});

test('publishBind forwards the fallback warning and still provides loopback', () => {
	const fake = fakeCtx({});
	publishBind(fake.ctx, { host: '127.0.0.1', source: 'fallback', warning: 'web-lan-bind: no IPv4' });
	assert.deepEqual(fake.provided, { webLanBind: { host: '127.0.0.1' } });
	assert.deepEqual(fake.warned, ['web-lan-bind: no IPv4']);
	assert.deepEqual(fake.informed, ['web-lan-bind: listening on 127.0.0.1 (fallback)']);
});

const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const patches = yaml.load(patchText, { schema: entryListSchema });

/**
 * The rows this layer targets, as `dsh-web-app` inserts them: the patch replaces
 * `config` wholesale and has to match `id` and `name`, so those are the fields
 * that matter here. The `!!js` values are the include's own expression nodes.
 */
function dshWebAppRows() {
	return [
		{
			id: 'webserver',
			name: '@deepseek-ai/dsh-host-webserver',
			inject: ['webStartup'],
			config: {
				host: { __jsExpr: "ctx.webStartup.host ?? '127.0.0.1'" },
				port: { __jsExpr: 'ctx.webStartup.port ?? 3080' },
				tls: { __jsExpr: 'ctx.webStartup.tls' },
				compression: 'gzip',
				compressionLevel: 1,
				compressionThresholdBytes: 1024
			}
		},
		{
			id: 'connection',
			name: '@deepseek-ai/dsh-client-connection',
			inject: ['webStartup'],
			config: { trustedHosts: { __jsExpr: 'ctx.webStartup.trustedHosts' }, cookieMaxAgeDays: 30 }
		}
	];
}

/**
 * The Loader's interpolation scope: `interpolate` evaluates `with (ctx)`, so the
 * scope has to be reachable as `ctx` from inside the expression (the real
 * context exposes itself that way through its tracker proxy).
 */
function bundleScope({ startup, bindHost, env = {} }) {
	const scope = { webStartup: startup, webLanBind: { host: bindHost }, process: { env } };
	scope.ctx = scope;
	return scope;
}

/** The composed tree, with any skipped patch reported. */
function composeBundle() {
	const skipped = [];
	const composed = applyEntryPatches(dshWebAppRows(), patches, (message, ...args) => skipped.push([message, ...args]));
	assert.deepEqual(skipped, [], 'every patch row must find its target');
	return composed;
}

test('the bundle inserts the resolver and rewires the two host rows', () => {
	const composed = composeBundle();

	// The inserted row must be resolvable through the package's own exports.
	assert.equal(manifest.exports['./bind'], './lib/bind.js');
	const bindRow = composed.find((row) => row.id === 'dsh-web-lan-bind');
	assert.equal(bindRow.name, '@lolkda/dsh-web-lan/bind');
	assert.equal(bindRow.inject, undefined, 'the module declares its own inject list');

	const webserver = composed.find((row) => row.id === 'webserver');
	assert.deepEqual(webserver.inject, ['webStartup', 'webLanBind']);
	// A patch replaces `config` wholesale, so the transport keys have to be restated.
	assert.equal(webserver.config.compression, 'gzip');
	assert.equal(webserver.config.compressionLevel, 1);
	assert.equal(webserver.config.compressionThresholdBytes, 1024);

	const connection = composed.find((row) => row.id === 'connection');
	assert.deepEqual(connection.inject, ['webStartup']);
	assert.equal(connection.config.cookieMaxAgeDays, 3650);
	// The removed service must not come back as a source: trust is read from
	// webStartup only (checked on the parsed layer, so prose may still name it).
	assert.doesNotMatch(JSON.stringify(patches), /webRuntime/u);
});

test('the webserver row takes the resolved address, not the raw flag or a default', () => {
	const webserver = composeBundle().find((row) => row.id === 'webserver');
	const startup = { host: '10.9.9.9', port: 4321, tls: { certFile: 'cert.pem', keyFile: 'key.pem' }, trustedHosts: [] };

	const config = interpolate(bundleScope({ startup, bindHost: '192.168.1.100' }), webserver.config);
	assert.equal(config.host, '192.168.1.100');
	assert.equal(config.port, 4321);
	assert.deepEqual(config.tls, { certFile: 'cert.pem', keyFile: 'key.pem' });

	// No --port means the composed default; --port 0 must stay 0 so the OS picks.
	assert.equal(interpolate(bundleScope({ startup: {}, bindHost: '192.168.1.100' }), webserver.config).port, 3080);
	assert.equal(interpolate(bundleScope({ startup: { port: 0 }, bindHost: '192.168.1.100' }), webserver.config).port, 0);
	// An explicit loopback choice reaches the webserver as loopback.
	assert.equal(interpolate(bundleScope({ startup: {}, bindHost: '127.0.0.1' }), webserver.config).host, '127.0.0.1');
});

test('the connection row keeps the invocation authorities and the environment, and nothing else', () => {
	const connection = composeBundle().find((row) => row.id === 'connection');
	const scope = bundleScope({
		startup: { trustedHosts: ['cli.example'] },
		bindHost: '192.168.1.100',
		env: { DSH_WEB_TRUSTED_HOSTS: ' app.internal , ,lan.local:3080 ' }
	});
	assert.deepEqual(interpolate(scope, connection.config).trustedHosts, ['cli.example', 'app.internal', 'lan.local:3080']);
	// Without the environment knob the flag list alone survives.
	const plain = bundleScope({ startup: { trustedHosts: [] }, bindHost: '192.168.1.100' });
	assert.deepEqual(interpolate(plain, connection.config).trustedHosts, []);
});

/**
 * Mount the composed rows in a real Cordis Loader. The webserver plugin belongs
 * to DSH, which is not a dependency of this checkout, so a builtin stands in for
 * it — what this proves is this bundle's wiring: the inserted row provides
 * `webLanBind`, and a row written exactly like the composed webserver row (same
 * inject list, same `!!js` config) resolves its host through that service.
 */
async function mountComposedRows(startup) {
	const root = new Context();
	await root.plugin(Loader, { baseUrl: new URL('../cordis.patch.yml', import.meta.url).href }).await?.();
	await root.plugin({
		name: 'test-web-startup',
		apply(ctx) { ctx.provide('webStartup', startup); }
	}).await?.();
	const seen = { configs: [] };
	root.loader.builtins['test-webserver'] = {
		name: 'test-webserver',
		inject: ['webStartup', 'webLanBind'],
		apply(ctx, config) { seen.configs.push(config); seen.bind = { ...ctx.webLanBind }; }
	};
	const composed = composeBundle();
	const webserver = composed.find((row) => row.id === 'webserver');
	const bindRow = composed.find((row) => row.id === 'dsh-web-lan-bind');
	// The dsh-web-app row is created where it sits in the tree; this bundle's
	// insert is appended after it, which is exactly the order under test.
	await root.loader.create({ ...webserver, name: 'cordis:test-webserver' }, null, Infinity);
	await root.loader.create({ id: bindRow.id, name: new URL('../lib/bind.js', import.meta.url).href }, null, Infinity);
	try {
		await root.loader.await();
		const states = Object.fromEntries([...root.loader.entries()].map((entry) => [entry.id, entry.fiber?.state]));
		return { seen, states };
	} finally {
		await root.fiber.dispose();
	}
}

test('the composed rows mount through the real Loader on the resolved address', async () => {
	const expected = await withEnv(
		{ DSH_WEB_HOST: undefined, DSH_WEB_LOOPBACK: undefined },
		() => resolveBindHost({ env: process.env, interfaces: networkInterfaces() })
	);
	const { seen, states } = await mountComposedRows({ port: 4321, tls: { certFile: 'cert.pem', keyFile: 'key.pem' }, trustedHosts: ['cli.example'] });

	assert.equal(states['dsh-web-lan-bind'], 2, 'the resolver row must become active');
	assert.equal(states.webserver, 2, 'the webserver row must become active after it');
	assert.deepEqual(seen.bind, { host: expected.host });
	assert.equal(seen.configs.length, 1);
	assert.equal(seen.configs[0].host, expected.host);
	assert.equal(seen.configs[0].port, 4321);
	assert.deepEqual(seen.configs[0].tls, { certFile: 'cert.pem', keyFile: 'key.pem' });
});

test('a wildcard --host fails the rows instead of falling back to a working server', async () => {
	const { seen, states } = await mountComposedRows({ host: '0.0.0.0', port: 4321, trustedHosts: [] });
	assert.notEqual(states['dsh-web-lan-bind'], 2, 'the resolver row must not become active');
	assert.notEqual(states.webserver, 2, 'the webserver row must never mount');
	assert.deepEqual(seen.configs, []);
});
