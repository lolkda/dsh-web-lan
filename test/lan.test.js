import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { apply, inject, ipv4Addresses, name } from '../lib/index.js';

/** Minimal stand-ins for the two injected services. */
function fakeCtx({ host = '0.0.0.0', port = 3080, protocol = 'http:' } = {}) {
	const registered = [];
	const disposed = [];
	const disposers = [];
	const listeners = new Map();
	return {
		listeners,
		on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
		registered,
		disposed,
		disposers,
		webServer: {
			host,
			port,
			protocol,
			register: (route) => {
				registered.push(route);
				return () => disposed.push(route.path);
			}
		},
		connection: {
			requestRejection: () => undefined,
			// Mirrors HostConnectionService.authenticatedUrl: normalizes to the clean
			// root and then attaches the process token, so a base with a trailing
			// slash does not produce a double slash.
			authenticatedUrl: (base) => {
				const url = new URL(base);
				url.pathname = '/';
				url.search = '';
				url.searchParams.set('token', 'TOKEN');
				return url.href;
			}
		},
		// Mirrors ctx.effect: the factory runs at mount and returns the disposer,
		// which cordis calls on unmount. It is NOT called during apply.
		effect: (factory) => { disposers.push(factory()); },
		logger: { warn: () => {} }
	};
}

/** Run `body` with `console.log` captured; returns the printed lines. */
function captureLogs(body) {
	const lines = [];
	const original = console.log;
	console.log = (message) => { lines.push(String(message)); };
	try {
		body();
	} finally {
		console.log = original;
	}
	return lines;
}

/** Every printed line that carries an openable URL. */
function urls(lines) {
	return lines.filter((line) => /https?:\/\//u.test(line));
}

/** The value the plugin publishes on the authenticated index injection contract. */
function settingsFlag(ctx) {
	const handler = ctx.listeners.get('webserver/index-inject');
	assert.equal(typeof handler, 'function', 'the plugin must subscribe to index injection');
	const rows = [];
	handler(rows);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].kind, 'global');
	assert.equal(rows[0].name, '__DSH_WEB_LAN_SETTINGS__');
	return rows[0].value;
}

test('exports the Cordis plugin contract', () => {
	assert.equal(name, 'web-lan');
	assert.deepEqual(inject, ['webServer', 'connection']);
});

test('ipv4Addresses returns non-internal IPv4 literals only', () => {
	const addresses = ipv4Addresses();
	assert.ok(Array.isArray(addresses));
	for (const address of addresses) {
		assert.match(address, /^\d+\.\d+\.\d+\.\d+$/u);
		assert.notEqual(address, '127.0.0.1');
	}
});

test('defaults register no route (autoLogin off)', () => {
	const ctx = fakeCtx();
	apply(ctx, undefined);
	assert.deepEqual(ctx.registered, []);
});

test('autoLogin registers an exact route outside the SPA fallback', () => {
	const ctx = fakeCtx();
	apply(ctx, { autoLogin: true });
	assert.equal(ctx.registered.length, 1);
	assert.equal(ctx.registered[0].kind, 'exact');
	assert.equal(ctx.registered[0].path, '/go');
	// Mount returns a disposer without disposing; unmount releases the route.
	assert.deepEqual(ctx.disposed, []);
	assert.equal(typeof ctx.disposers[0], 'function');
	ctx.disposers[0]();
	assert.deepEqual(ctx.disposed, ['/go']);
});

test('autoLogin honours a custom bootstrapPath and rejects a malformed one', () => {
	const custom = fakeCtx();
	apply(custom, { autoLogin: true, bootstrapPath: '/enter' });
	assert.equal(custom.registered[0].path, '/enter');

	const malformed = fakeCtx();
	apply(malformed, { autoLogin: true, bootstrapPath: 'go' });
	assert.equal(malformed.registered[0].path, '/go');
});

test('the entry redirects with the process token', () => {
	const ctx = fakeCtx();
	apply(ctx, { autoLogin: true });
	const seen = {};
	const res = {
		writeHead: (status, headers) => { seen.status = status; seen.headers = headers; },
		end: () => { seen.ended = true; }
	};
	ctx.registered[0].handler({ method: 'GET', headers: { host: '192.168.1.5:3080' } }, res);
	assert.equal(seen.status, 303);
	assert.equal(seen.headers.location, 'http://192.168.1.5:3080/?token=TOKEN');
	assert.equal(seen.ended, true);
});

test('the entry refuses a non-GET method and an untrusted Host', () => {
	const ctx = fakeCtx();
	apply(ctx, { autoLogin: true });
	const status = (req) => {
		let seen;
		ctx.registered[0].handler(req, { writeHead: (code) => { seen = code; }, end: () => {} });
		return seen;
	};
	assert.equal(status({ method: 'POST', headers: { host: '192.168.1.5:3080' } }), 405);

	const untrusted = fakeCtx();
	untrusted.connection.requestRejection = () => 403;
	apply(untrusted, { autoLogin: true });
	let code;
	untrusted.registered[0].handler({ method: 'GET', headers: { host: 'evil.example' } }, { writeHead: (c) => { code = c; }, end: () => {} });
	assert.equal(code, 403);
});

test('the shipped bundle layer enables the token-free entry by default', async () => {
	const layer = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	// 0.3.0 makes the /go entry opt-out: the row the bundle inserts must carry
	// autoLogin: true, otherwise every install silently keeps requiring a token
	// per device — the opposite of what README and the package description say.
	assert.match(layer, /^\s*autoLogin: true\s*$/mu);
	assert.doesNotMatch(layer, /^\s*autoLogin: false\s*$/mu);
});

test('a concrete non-loopback bind is LAN: settings on, that address and no other', () => {
	const ctx = fakeCtx({ host: '192.168.1.5' });
	let warned = '';
	ctx.logger.warn = (message) => { warned = message; };
	const lines = captureLogs(() => apply(ctx, { autoLogin: true }));
	assert.equal(warned, '', 'a concrete interface bind must not be reported as non-LAN');
	assert.equal(settingsFlag(ctx), true);
	// Exactly one URL, for the address the socket actually bound: never another
	// interface's address, and never the bind literal spelled as a host.
	assert.deepEqual(urls(lines), ['dsh-web-lan:   http://192.168.1.5:3080/go']);
});

test('a concrete non-loopback bind prints the address the token URL also uses', () => {
	const ctx = fakeCtx({ host: '10.20.30.40', port: 8443 });
	const lines = captureLogs(() => apply(ctx, {}));
	assert.deepEqual(urls(lines), ['dsh-web-lan:   http://10.20.30.40:8443/?token=TOKEN']);
	assert.equal(settingsFlag(ctx), true);
});

test('a concrete IPv6 bind is printed bracketed and counts as LAN', () => {
	const ctx = fakeCtx({ host: 'fd00::5' });
	let warned = '';
	ctx.logger.warn = (message) => { warned = message; };
	const lines = captureLogs(() => apply(ctx, { autoLogin: true }));
	assert.equal(warned, '');
	assert.equal(settingsFlag(ctx), true);
	assert.deepEqual(urls(lines), ['dsh-web-lan:   http://[fd00::5]:3080/go']);
});

test('an IPv6 bind keeps the zone selector out of the printed URL host', () => {
	const ctx = fakeCtx({ host: 'fe80::1%eth0' });
	const lines = captureLogs(() => apply(ctx, {}));
	// A zone picks a local interface and is not URL host text; keeping it would
	// make the token URL throw inside authenticatedUrl.
	assert.deepEqual(urls(lines), ['dsh-web-lan:   http://[fe80::1]:3080/?token=TOKEN']);
});

test('every loopback form disables LAN settings, warns, and claims no LAN URL', () => {
	const loopbacks = ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:0:0:1'];
	for (const host of loopbacks) {
		const ctx = fakeCtx({ host });
		let warned = '';
		ctx.logger.warn = (message) => { warned = message; };
		const lines = captureLogs(() => apply(ctx, { autoLogin: true }));
		assert.equal(settingsFlag(ctx), false, `${host} must not enable the browser LAN settings`);
		assert.match(warned, /bound to /u, host);
		assert.match(warned, /loopback/u, host);
		assert.equal(urls(lines).length, 1, `${host} prints only the address it bound`);
		assert.equal(lines.some((line) => line.includes('家用局域网')), false, `${host} must not advertise LAN reachability`);
	}
});

test('remoteSettings: false opts out even on a concrete LAN bind', () => {
	const ctx = fakeCtx({ host: '192.168.1.5' });
	captureLogs(() => apply(ctx, { remoteSettings: false, printLanUrls: false }));
	assert.equal(settingsFlag(ctx), false);
});

test('a TLS listener prints and redirects with https', () => {
	const ctx = fakeCtx({ host: '192.168.1.5', protocol: 'https:' });
	const lines = captureLogs(() => apply(ctx, { autoLogin: true }));
	assert.deepEqual(urls(lines), ['dsh-web-lan:   https://192.168.1.5:3080/go']);

	const seen = {};
	ctx.registered[0].handler(
		{ method: 'GET', headers: { host: '192.168.1.5:3080' } },
		{ writeHead: (status, headers) => { seen.status = status; seen.headers = headers; }, end: () => {} }
	);
	assert.equal(seen.status, 303);
	assert.equal(seen.headers.location, 'https://192.168.1.5:3080/?token=TOKEN');
});

test('a host without a protocol getter is reported as plain HTTP', () => {
	const ctx = fakeCtx({ host: '192.168.1.5' });
	delete ctx.webServer.protocol;
	const lines = captureLogs(() => apply(ctx, {}));
	assert.deepEqual(urls(lines), ['dsh-web-lan:   http://192.168.1.5:3080/?token=TOKEN']);
});

test('a legacy all-interfaces bind lists the interfaces it really serves', () => {
	const ctx = fakeCtx({ host: '0.0.0.0' });
	const lines = captureLogs(() => apply(ctx, { autoLogin: true }));
	assert.equal(settingsFlag(ctx), true);
	const printed = urls(lines);
	assert.equal(printed.length, ipv4Addresses().length);
	for (const line of printed) assert.equal(line.includes('0.0.0.0'), false);
});

test('advertises LAN settings through the authenticated index injection contract', () => {
	const ctx = fakeCtx();
	apply(ctx, { printLanUrls: false });
	const handler = ctx.listeners.get('webserver/index-inject');
	assert.equal(typeof handler, 'function');
	const rows = [];
	handler(rows);
	assert.deepEqual(rows, [{ kind: 'global', name: '__DSH_WEB_LAN_SETTINGS__', value: true }]);
	assert.equal(ctx.registered.length, 0, 'enabling settings must not create an authentication bypass route');
});

test('LAN settings opt-out and loopback escape both disable the browser extension', () => {
	for (const [options, config] of [[{}, { remoteSettings: false }], [{ host: '127.0.0.1' }, {}]]) {
		const ctx = fakeCtx(options);
		apply(ctx, { ...config, printLanUrls: false });
		const rows = [];
		assert.equal(typeof ctx.listeners.get('webserver/index-inject'), 'function');
		ctx.listeners.get('webserver/index-inject')(rows);
		assert.equal(rows[0].value, false);
	}
});
