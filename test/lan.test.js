import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, inject, ipv4Addresses, name } from '../lib/index.js';

/** Minimal stand-ins for the two injected services. */
function fakeCtx({ host = '0.0.0.0', port = 3080 } = {}) {
	const registered = [];
	const disposed = [];
	const disposers = [];
	return {
		registered,
		disposed,
		disposers,
		webServer: {
			host,
			port,
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

test('a non-all-interfaces bind warns instead of advertising unreachable URLs', () => {
	const ctx = fakeCtx({ host: '127.0.0.1' });
	let warned = '';
	ctx.logger.warn = (message) => { warned = message; };
	apply(ctx, {});
	assert.match(warned, /bound to 127\.0\.0\.1/u);
});
