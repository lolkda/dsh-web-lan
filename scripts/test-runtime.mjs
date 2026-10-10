#!/usr/bin/env node
/**
 * Real-boot acceptance for the packed package against DSH 0.2.1-alpha.2.
 *
 * Everything this script asserts comes from a DSH process it started itself, from
 * the tarball it built itself, under a `HOME`/`DSH_HOME` it created itself:
 *
 *   1. `npm pack` the working tree — the artifact under test is the current
 *      checkout, never the registry copy and never the live GUI.
 *   2. `npm install @deepseek-ai/dsh@0.2.1-alpha.2 --ignore-scripts` into a temp
 *      host, so the runtime under test is pinned and isolated.
 *   3. `dsh plugin --profile web add <tarball>` into a temp `DSH_HOME`, then boot
 *      `dsh web --no-open --port 0` for every bind scenario.
 *
 * The child environment drops every inherited `DSH_*` variable before anything
 * is spawned. The operator's own DSH (`DSH_HOME`, `DSH_PROFILE`, `DSH_WEB_URL`
 * pointing at the running Web GUI) must never leak into a scenario: inheriting
 * it would boot the live profile and mutate state outside this test.
 *
 * Verified behaviours, all against a real listener:
 *   - bind precedence `--host` > `DSH_WEB_LOOPBACK=1` > `DSH_WEB_HOST` > the
 *     first non-internal IPv4, plus the three explicit-address refusals.
 *   - on a concrete non-loopback address: `/go` -> 303 + token, token -> the
 *     authority-bound `dsh-auth-*` cookie, authenticated index with the
 *     `__DSH_WEB_LAN_SETTINGS__` flag true and an intact client entry in
 *     `__DSH_BOOT__`, authenticated `/api` dispatch, 401 without a cookie and
 *     403 for an authority the fence does not trust.
 *   - on loopback: the same login flow with the flag false.
 *
 * Deliberate scope limits:
 *   - The client half is verified as served and referenced (the boot payload
 *     entry and the `client.js` bytes), not executed: no browser is driven here,
 *     so this is not browser-side acceptance of the in-page settings provider.
 *   - This file lives outside `test/` on purpose. Node's default `node --test`
 *     discovery runs every file under a `test/` directory (measured on Node 24),
 *     so a runtime acceptance that installs a 560-package DSH would otherwise
 *     run on a bare `npm test`. It is invoked explicitly:
 *         npm run test:runtime
 *
 * Environment knobs:
 *   DSH_LAN_KEEP=1     keep the temp workspace and print its path for debugging.
 *   DSH_LAN_DSH_VERSION override the pinned DSH version (default 0.2.1-alpha.2).
 *
 * @module scripts/test-runtime
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root; the tree `npm pack` archives. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The harness release this acceptance is written against. */
const DSH_VERSION = process.env.DSH_LAN_DSH_VERSION ?? '0.2.1-alpha.2';

/** The package under test, as the profile records it. */
const PLUGIN_NAME = '@lolkda/dsh-web-lan';

/** Files that must reach the installed profile byte-for-byte from this checkout. */
const PROVENANCE_FILES = ['lib/index.js', 'lib/bind.js', 'lib/client.js', 'cordis.patch.yml'];

/** Token-free entry the shipped bundle patch configures. */
const BOOTSTRAP_PATH = '/go';

/** An authenticated, read-only Typert Remote method that exists in the web profile. */
const API_METHOD = 'pluginInventory/list';

/** Browser-session cookie prefix owned by `@deepseek-ai/dsh-client-connection`. */
const COOKIE_PREFIX = 'dsh-auth-';

/** The deployment opt-in flag the host half publishes into the index. */
const SETTINGS_FLAG = '__DSH_WEB_LAN_SETTINGS__';

/** The boot payload global the client module loader consumes. */
const BOOT_GLOBAL = '__DSH_BOOT__';

/** Port the operator's live GUI answers on; no scenario may ever reach it. */
const LIVE_GUI_PORT = 3080;

/** `cookieMaxAgeDays: 3650` from this bundle's patch layer, in seconds. */
const EXPECTED_COOKIE_MAX_AGE = 315_360_000;

const PACK_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 900_000;
const PLUGIN_ADD_TIMEOUT_MS = 300_000;
const BOOT_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 20_000;

/** Booted children not yet reaped, so a failing assertion still tears them down. */
const live = new Set();

/** Machine-readable result rows for the summary. */
const summary = [];

let rpcCounter = 0;

/** @param {string} message line to print. */
function note(message) {
	process.stdout.write(`${message}\n`);
}

/** @param {string} label */
function phase(label) {
	process.stdout.write(`\n=== ${label} ===\n`);
}

/** @param {number} milliseconds @returns {Promise<void>} resolves after the delay. */
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** @param {string} text @returns {string} the same text with any launch token redacted. */
function redact(text) {
	return text.replaceAll(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1[REDACTED]');
}

/**
 * Run one command to completion.
 * @param {string} command - executable.
 * @param {string[]} args - arguments, passed without a shell.
 * @param {{cwd?: string, env?: Record<string, string>, timeoutMs?: number, label: string}} options - spawn inputs.
 * @returns {{status: number, stdout: string, stderr: string}} the captured result.
 */
function run(command, args, options) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: 'utf8',
		timeout: options.timeoutMs,
		maxBuffer: 64 * 1024 * 1024
	});
	if (result.error !== undefined) throw new Error(`${options.label}: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(
			`${options.label} failed with status ${String(result.status)}:\n`
			+ redact(`${result.stdout ?? ''}${result.stderr ?? ''}`).slice(-4000)
		);
	}
	return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** @param {string} text @returns {string} the sha256 hex digest of the utf8 text. */
function sha256(text) {
	return createHash('sha256').update(text).digest('hex');
}

/** @param {Buffer|string} value @returns {string} unpadded base64url. */
function base64url(value) {
	return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * The cookie name `@deepseek-ai/dsh-client-connection` derives for one authority.
 * @param {string} authority - the request authority, `host:port` over plain HTTP.
 * @returns {string} the generated cookie name.
 */
function cookieNameFor(authority) {
	return COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
}

/**
 * The first non-internal IPv4 of this machine, the address the automatic branch
 * selects. Read independently of the plugin so the assertion is not circular.
 * @returns {string} the address literal.
 * @throws when this machine has no non-loopback IPv4 to test with.
 */
function firstExternalIpv4() {
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.family === 'IPv4' && !iface.internal) return iface.address;
		}
	}
	throw new Error('this machine has no non-internal IPv4 address, so LAN acceptance cannot run here');
}

/**
 * The environment every child gets: a temp HOME and DSH_HOME, no inherited DSH
 * state, and a temp npm cache so no shared cache directory is written. An empty
 * variable counts as present in Node, so a scenario's blank value reaches the
 * plugin instead of being silently dropped here.
 * @param {string} work - temp workspace root.
 * @param {Record<string, string>} extra - scenario variables added last.
 * @returns {Record<string, string>} the child environment.
 */
function childEnv(work, extra = {}) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// The live GUI's home, profile, and advertised URL must never reach a scenario.
		if (key.startsWith('DSH_')) continue;
		if (key === 'NODE_OPTIONS') continue;
		if (key === 'npm_config_cache') continue;
		if (key === 'npm_config_registry') continue;
		env[key] = value;
	}
	env.HOME = join(work, 'home');
	env.DSH_HOME = join(work, 'dsh-home');
	// Both are created up front: package managers and the profile boot write here,
	// and an absent HOME only produces avoidable warnings.
	mkdirSync(env.HOME, { recursive: true });
	mkdirSync(env.DSH_HOME, { recursive: true });
	env.npm_config_cache = join(work, 'npm-cache');
	env.npm_config_registry = process.env.npm_config_registry ?? 'https://registry.npmjs.org/';
	return { ...env, ...extra };
}

/**
 * One HTTP request with an explicit Host header, no redirect following, and no
 * cookie store: every step of the login flow is asserted separately.
 * @param {{connectHost: string, port: number, path: string, method?: string, headers?: Record<string, string>, body?: string}} request - probe inputs.
 * @returns {Promise<{status: number, headers: Record<string, string|string[]|undefined>, body: string}>} the response.
 */
function probe(request) {
	return new Promise((settle, fail) => {
		const payload = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');
		const headers = payload === undefined
			? { ...request.headers }
			: { ...request.headers, 'content-length': String(payload.byteLength) };
		const outgoing = httpRequest({
			host: request.connectHost,
			port: request.port,
			path: request.path,
			method: request.method ?? 'GET',
			headers,
			timeout: PROBE_TIMEOUT_MS
		}, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => settle({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString('utf8')
			}));
		});
		outgoing.on('timeout', () => outgoing.destroy(new Error(
			`probe timed out after ${String(PROBE_TIMEOUT_MS)}ms: ${request.method ?? 'GET'} ${request.path}`
		)));
		outgoing.on('error', fail);
		if (payload !== undefined) outgoing.write(payload);
		outgoing.end();
	});
}

/**
 * Boot one `dsh web` child and wait for its advertised URL.
 * @param {object} scenario - boot inputs.
 * @param {string} scenario.label - scenario name used in messages.
 * @param {string} scenario.work - temp workspace root.
 * @param {string} scenario.hostDir - directory holding the temp DSH install.
 * @param {string} scenario.dshBin - the pinned DSH entry point.
 * @param {string[]} scenario.args - extra `dsh web` arguments.
 * @param {Record<string, string>} scenario.env - scenario environment additions.
 * @param {string} scenario.expectHost - the address the URL line must advertise.
 * @returns {Promise<object>} the running instance, with `output()` and `stop()`.
 */
async function boot(scenario) {
	const child = spawn(process.execPath, [scenario.dshBin, 'web', '--no-open', '--port', '0', ...scenario.args], {
		cwd: scenario.hostDir,
		env: childEnv(scenario.work, scenario.env),
		stdio: ['ignore', 'pipe', 'pipe'],
		// Its own process group, so teardown reaches every descendant at once.
		detached: true
	});
	let output = '';
	let exit = null;
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => { output += chunk; });
	child.stderr.on('data', (chunk) => { output += chunk; });
	const exited = new Promise((settle) => {
		child.once('exit', (code, signal) => {
			exit = { code, signal };
			settle(exit);
		});
	});
	const instance = {
		label: scenario.label,
		child,
		exited,
		output: () => output,
		stop: async () => {
			if (exit === null) {
				try {
					process.kill(-child.pid, 'SIGTERM');
				} catch {
					// Already gone; `exited` still settles.
				}
				const escalation = setTimeout(() => {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						// Already gone.
					}
				}, 10_000);
				await exited;
				clearTimeout(escalation);
			}
			live.delete(instance);
		}
	};
	live.add(instance);

	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	for (;;) {
		const advertised = /^dsh web: (https?:\/\/\S+)$/mu.exec(output);
		if (advertised !== null) {
			const url = new URL(advertised[1]);
			const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
			assert.equal(host, scenario.expectHost, `${scenario.label}: bound ${host}, expected ${scenario.expectHost}`);
			assert.notEqual(Number(url.port), LIVE_GUI_PORT, `${scenario.label}: must not be the live GUI port`);
			instance.host = host;
			instance.port = Number(url.port);
			instance.token = url.searchParams.get('token');
			return instance;
		}
		if (exit !== null) {
			throw new Error(
				`${scenario.label}: dsh web exited (code ${String(exit.code)}, signal ${String(exit.signal)}) before advertising a URL:\n`
				+ redact(output).slice(-4000)
			);
		}
		if (Date.now() > deadline) {
			throw new Error(`${scenario.label}: no URL after ${String(BOOT_TIMEOUT_MS)}ms:\n${redact(output).slice(-4000)}`);
		}
		await delay(250);
	}
}

/**
 * Stop one instance and wait for its whole process group to go away.
 * @param {object} instance - a {@link boot} result.
 */
async function stop(instance) {
	await instance.stop();
}

/**
 * Read and validate the browser-session cookie out of a token exchange.
 * @param {string[]} setCookie - every `set-cookie` value of the response.
 * @param {string} authority - the authority the request was made with.
 * @param {string} label - scenario name for messages.
 * @returns {{name: string, value: string, raw: string}} the session cookie.
 */
function sessionCookie(setCookie, authority, label) {
	const raw = setCookie.find((value) => value.startsWith(COOKIE_PREFIX));
	assert.ok(raw !== undefined, `${label}: token exchange minted no ${COOKIE_PREFIX}* cookie`);
	const pair = raw.split(';', 1)[0];
	const at = pair.indexOf('=');
	const name = pair.slice(0, at).trim();
	const value = pair.slice(at + 1).trim();
	assert.equal(name, cookieNameFor(authority), `${label}: cookie name must bind to the request authority`);
	assert.match(raw, /HttpOnly/u, `${label}: session cookie must be HttpOnly`);
	assert.match(raw, /SameSite=Strict/u, `${label}: session cookie must be SameSite=Strict`);
	assert.match(raw, /Path=\//u, `${label}: session cookie must be scoped to the site root`);
	// 3650 days is the bundle patch layer's `cookieMaxAgeDays`; the DSH default is 30.
	assert.match(
		raw,
		new RegExp(`Max-Age=${String(EXPECTED_COOKIE_MAX_AGE)}(?:;|$)`, 'u'),
		`${label}: the pack's cookieMaxAgeDays did not reach the session cookie`
	);
	const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
	assert.equal(payload.authority, authority, `${label}: cookie payload must name the request authority`);
	return { name, value, raw };
}

/**
 * Post one Typert Remote call over the authenticated `/api` transport.
 * @param {object} instance - running instance.
 * @param {string} method - the remote method, also the URL endpoint.
 * @param {{cookie?: string, host: string, args?: object}} options - request shaping.
 * @returns {Promise<{status: number, body: string, json: any}>} the response.
 */
async function callApi(instance, method, options) {
	const body = JSON.stringify({
		type: 'client-request',
		rpcId: `runtime-acceptance-${String(++rpcCounter)}`,
		method,
		payload: { args: options.args ?? {} }
	});
	const response = await probe({
		connectHost: instance.host,
		port: instance.port,
		path: `/api/${method}`,
		method: 'POST',
		headers: {
			host: options.host,
			'content-type': 'application/json',
			...(options.cookie === undefined ? {} : { cookie: options.cookie })
		},
		body
	});
	let json;
	try {
		json = JSON.parse(response.body);
	} catch {
		json = undefined;
	}
	return { ...response, json };
}

/**
 * The full authenticated acceptance on one live listener: the token-free entry,
 * the cookie exchange, the index contract, the client entry, and the `/api`
 * fence.
 * @param {object} instance - running instance.
 * @param {boolean} expectedFlag - the `__DSH_WEB_LAN_SETTINGS__` value this bind must publish.
 * @param {Record<string, number>} counters - shared check counter.
 */
async function verifyListener(instance, expectedFlag, counters) {
	const { label, host, port } = instance;
	const authority = `${host}:${String(port)}`;
	const call = (options) => probe({ connectHost: host, port, ...options });
	const check = (name) => {
		counters.checks += 1;
		note(`  ok  ${label}: ${name}`);
	};

	// The host half ran at all, and reported the address it really bound.
	assert.match(instance.output(), /^dsh-web-lan: listening on /mu, `${label}: the packed host half did not report a listener`);
	check('packed host half reported the listener');

	// 1. The token-free entry answers with a token redirect for its own authority.
	const entry = await call({ path: BOOTSTRAP_PATH, headers: { host: authority } });
	assert.equal(entry.status, 303, `${label}: ${BOOTSTRAP_PATH} must answer 303`);
	assert.equal(entry.headers.location?.startsWith(`http://${authority}/`), true, `${label}: ${BOOTSTRAP_PATH} must redirect to its own authority`);
	const token = new URL(entry.headers.location).searchParams.get('token');
	assert.ok(typeof token === 'string' && token.length > 0, `${label}: ${BOOTSTRAP_PATH} must carry a launch token`);
	assert.match(entry.headers.location, /\?token=[A-Za-z0-9_-]+$/u, `${label}: the token must be the sole query parameter`);
	check(`${BOOTSTRAP_PATH} -> 303 with the launch token`);

	// 2. Only GET/HEAD reach the entry.
	const posted = await call({ path: BOOTSTRAP_PATH, method: 'POST', headers: { host: authority } });
	assert.equal(posted.status, 405, `${label}: ${BOOTSTRAP_PATH} must refuse POST`);
	check(`${BOOTSTRAP_PATH} refuses POST with 405`);

	// 3. The launch token mints the authority-bound browser cookie.
	const exchange = await call({ path: `/?token=${token}`, headers: { host: authority } });
	assert.equal(exchange.status, 303, `${label}: the token exchange must answer 303`);
	assert.equal(exchange.headers.location, './', `${label}: the token exchange must redirect to the clean root`);
	const setCookie = exchange.headers['set-cookie'];
	const cookie = sessionCookie(Array.isArray(setCookie) ? setCookie : [], authority, label);
	check(`token -> ${COOKIE_PREFIX}<sha256(authority)> cookie, 3650-day Max-Age`);

	// 4. The authenticated index carries the deployment flag and the client entry.
	const index = await call({ path: '/', headers: { host: authority, cookie: `${cookie.name}=${cookie.value}` } });
	assert.equal(index.status, 200, `${label}: the authenticated index must answer 200`);
	assert.match(index.body, /<div id="root">/u, `${label}: the index must be the built SPA shell`);
	const flag = new RegExp(`globalThis\\["${SETTINGS_FLAG}"\\]\\s*=\\s*(true|false)`, 'u').exec(index.body);
	assert.ok(flag !== null, `${label}: the authenticated index must publish ${SETTINGS_FLAG}`);
	assert.equal(flag[1] === 'true', expectedFlag, `${label}: ${SETTINGS_FLAG} must be ${String(expectedFlag)} on this bind`);
	check(`index publishes ${SETTINGS_FLAG} = ${String(expectedFlag)}`);
	const bootPayload = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*<\/script>/su.exec(index.body);
	assert.ok(bootPayload !== null, `${label}: the index must publish ${BOOT_GLOBAL}`);
	const clientEntry = JSON.parse(bootPayload[1]).entries.find((entry_) => entry_.id === PLUGIN_NAME);
	assert.ok(clientEntry !== undefined, `${label}: ${BOOT_GLOBAL} lost the ${PLUGIN_NAME} client entry`);
	assert.deepEqual(clientEntry.inject, ['@deepseek-ai/dsh-client-ui-settings'], `${label}: client entry injection drifted`);
	check(`${BOOT_GLOBAL} still lists the client entry`);

	// 5. That entry resolves to real bytes on this server.
	const clientUrl = new URL(clientEntry.url, `http://${authority}/`);
	const clientFile = await call({
		path: `${clientUrl.pathname}${clientUrl.search}`,
		headers: { host: authority, cookie: `${cookie.name}=${cookie.value}` }
	});
	assert.equal(clientFile.status, 200, `${label}: the client entry must be served`);
	assert.match(String(clientFile.headers['content-type']), /^text\/javascript/u, `${label}: the client entry must be JavaScript`);
	assert.match(clientFile.body, /__ModuleLoader__\.load\(/u, `${label}: the client entry must be the documented lazy factory`);
	assert.match(clientFile.body, new RegExp(`'${PLUGIN_NAME}'|"${PLUGIN_NAME}"`, 'u'), `${label}: the client entry must claim its own id`);
	check('the client entry is served as JavaScript from this listener');

	// 6. The authenticated API dispatch is real, and reaches the packed modules.
	const api = await callApi(instance, API_METHOD, { host: authority, cookie: `${cookie.name}=${cookie.value}` });
	assert.equal(api.status, 200, `${label}: the authenticated API must answer 200`);
	assert.equal(api.json?.result?.ok, true, `${label}: ${API_METHOD} must succeed: ${api.body.slice(0, 300)}`);
	const modules = api.json.result.value.entries.map((entry_) => entry_.moduleName);
	assert.ok(modules.includes(PLUGIN_NAME), `${label}: the packed plugin must be a loaded entry`);
	assert.ok(modules.includes(`${PLUGIN_NAME}/bind`), `${label}: the packed bind service must be a loaded entry`);
	check(`authenticated ${API_METHOD} -> ok, and both packed modules are loaded`);

	// 7. Admission, authentication, and Host trust are three separate refusals.
	const unclaimed = await callApi(instance, 'lan-runtime-probe/missing', { host: authority, cookie: `${cookie.name}=${cookie.value}` });
	assert.equal(unclaimed.status, 404, `${label}: an admitted but unclaimed endpoint must answer 404, not a fence refusal`);
	check('an admitted request reaches the router (404, not 401/403)');
	const anonymous = await callApi(instance, API_METHOD, { host: authority });
	assert.equal(anonymous.status, 401, `${label}: /api without a cookie must answer 401`);
	check('/api without a cookie -> 401');
	const foreign = await callApi(instance, API_METHOD, { host: `evil.invalid:${String(port)}`, cookie: `${cookie.name}=${cookie.value}` });
	assert.equal(foreign.status, 403, `${label}: /api under an untrusted authority must answer 403`);
	check('/api under an untrusted authority -> 403');
	const foreignEntry = await call({ path: BOOTSTRAP_PATH, headers: { host: `evil.invalid:${String(port)}` } });
	assert.equal(foreignEntry.status, 403, `${label}: ${BOOTSTRAP_PATH} under an untrusted authority must answer 403`);
	assert.match(foreignEntry.body, /not in trustedHosts/u, `${label}: the refusal must be the plugin's own guard`);
	check(`${BOOTSTRAP_PATH} under an untrusted authority -> 403 from the plugin guard`);
}

/**
 * Boot one scenario, assert its bind, and optionally run the full acceptance.
 * @param {object} options - scenario definition.
 * @returns {Promise<{host: string, port: number}>} the observed listener facts.
 */
async function scenario(options) {
	phase(`${options.label}${options.full === true ? ' (full acceptance)' : ''}`);
	const instance = await boot({
		label: options.label,
		work: options.work,
		hostDir: options.hostDir,
		dshBin: options.dshBin,
		args: options.args ?? [],
		env: options.env ?? {},
		expectHost: options.expectHost
	});
	try {
		note(`  bound ${instance.host}:${String(instance.port)}`);
		options.counters.boots += 1;
		if (options.full === true) await verifyListener(instance, options.expectFlag, options.counters);
		else await assertFlag(instance, options.expectFlag, options.counters);
		summary.push({ scenario: options.label, host: instance.host, port: instance.port, result: 'pass' });
		return { host: instance.host, port: instance.port };
	} catch (error) {
		summary.push({ scenario: options.label, host: instance.host, port: instance.port, result: 'fail' });
		throw error;
	} finally {
		await stop(instance);
	}
}

/**
 * The light check used by the precedence-only scenarios: read the authenticated
 * index through the token-free entry and compare the published flag.
 * @param {object} instance - running instance.
 * @param {boolean} expectedFlag - expected `__DSH_WEB_LAN_SETTINGS__` value.
 * @param {Record<string, number>} counters - shared check counter.
 */
async function assertFlag(instance, expectedFlag, counters) {
	const authority = `${instance.host}:${String(instance.port)}`;
	const call = (options) => probe({ connectHost: instance.host, port: instance.port, ...options });
	const entry = await call({ path: BOOTSTRAP_PATH, headers: { host: authority } });
	assert.equal(entry.status, 303, `${instance.label}: ${BOOTSTRAP_PATH} must answer 303`);
	const token = new URL(entry.headers.location).searchParams.get('token');
	const exchange = await call({ path: `/?token=${token}`, headers: { host: authority } });
	assert.equal(exchange.status, 303, `${instance.label}: the token exchange must answer 303`);
	const cookie = sessionCookie(Array.isArray(exchange.headers['set-cookie']) ? exchange.headers['set-cookie'] : [], authority, instance.label);
	const index = await call({ path: '/', headers: { host: authority, cookie: `${cookie.name}=${cookie.value}` } });
	assert.equal(index.status, 200, `${instance.label}: the authenticated index must answer 200`);
	const flag = new RegExp(`globalThis\\["${SETTINGS_FLAG}"\\]\\s*=\\s*(true|false)`, 'u').exec(index.body);
	assert.ok(flag !== null, `${instance.label}: the index must publish ${SETTINGS_FLAG}`);
	assert.equal(flag[1] === 'true', expectedFlag, `${instance.label}: ${SETTINGS_FLAG} must be ${String(expectedFlag)}`);
	counters.checks += 1;
	note(`  ok  ${instance.label}: ${SETTINGS_FLAG} = ${String(expectedFlag)}`);
}

/**
 * Assert one address refusal: the boot must fail, print the plugin's or the
 * CLI's own reason, and publish no listener.
 * @param {object} options - refusal definition.
 */
function expectRefusal(options) {
	phase(`${options.label} (must refuse to boot)`);
	const result = spawnSync(process.execPath, [options.dshBin, 'web', '--no-open', '--port', '0', ...(options.args ?? [])], {
		cwd: options.hostDir,
		env: childEnv(options.work, options.env ?? {}),
		encoding: 'utf8',
		timeout: EXIT_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024
	});
	const output = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`);
	assert.notEqual(result.status, 0, `${options.label}: a refused address must not start a server:\n${output.slice(-2000)}`);
	assert.match(output, options.pattern, `${options.label}: the refusal must name the reason:\n${output.slice(-2000)}`);
	assert.doesNotMatch(output, /^dsh web: https?:\/\//mu, `${options.label}: a refused address must publish no URL line`);
	options.counters.checks += 1;
	note(`  ok  ${options.label}: refused (${options.pattern})`);
	summary.push({ scenario: options.label, host: '-', port: '-', result: 'refused as expected' });
}

/**
 * Build the artifact and the isolated runtime, then prove the installed plugin
 * is this checkout rather than the registry copy or the live GUI's build.
 * @param {string} work - temp workspace root.
 * @returns {{tarball: string, hostDir: string, dshBin: string}} prepared paths.
 */
function prepare(work) {
	phase('npm pack the working tree');
	const packDir = join(work, 'pack');
	mkdirSync(packDir, { recursive: true });
	const packed = run('npm', ['pack', '--pack-destination', packDir, '--json'], {
		cwd: ROOT,
		env: childEnv(work),
		timeoutMs: PACK_TIMEOUT_MS,
		label: 'npm pack'
	});
	const tarball = join(packDir, JSON.parse(packed.stdout)[0].filename);
	assert.ok(existsSync(tarball), `npm pack produced no tarball at ${tarball}`);
	note(`  ${tarball}`);

	phase(`install @deepseek-ai/dsh@${DSH_VERSION} into a temp host`);
	const hostDir = join(work, 'host');
	mkdirSync(hostDir, { recursive: true });
	run('npm', ['install', `@deepseek-ai/dsh@${DSH_VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund'], {
		cwd: hostDir,
		env: childEnv(work),
		timeoutMs: INSTALL_TIMEOUT_MS,
		label: 'npm install @deepseek-ai/dsh'
	});
	const installedDsh = JSON.parse(readFileSync(join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
	assert.equal(installedDsh.version, DSH_VERSION, `the temp host must run the pinned DSH ${DSH_VERSION}`);
	const dshBin = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	assert.ok(existsSync(dshBin), `the pinned DSH has no entry point at ${dshBin}`);
	assert.ok(resolve(dshBin).startsWith(resolve(work) + sep), 'the DSH under test must live inside the temp workspace');
	note(`  ${installedDsh.name}@${installedDsh.version} at ${dshBin}`);

	phase('install the packed plugin into a temp web profile');
	run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', tarball], {
		cwd: hostDir,
		env: childEnv(work),
		timeoutMs: PLUGIN_ADD_TIMEOUT_MS,
		label: 'dsh plugin --profile web add'
	});
	const profileDir = join(work, 'dsh-home', 'profiles', 'web');
	const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
	assert.ok(manifest.dsh?.profile?.bundles?.includes(PLUGIN_NAME), `${PLUGIN_NAME} must be registered as a bundle`);
	assert.match(String(manifest.dependencies?.[PLUGIN_NAME]), /lolkda-dsh-web-lan-.*\.tgz$/u, 'the profile must depend on the tarball under test');
	note(`  bundles: ${manifest.dsh.profile.bundles.join(', ')}`);

	phase('prove the installed plugin is this checkout');
	const installedDir = join(profileDir, 'node_modules', ...PLUGIN_NAME.split('/'));
	assert.ok(resolve(installedDir).startsWith(resolve(work) + sep), 'the plugin under test must be installed inside the temp workspace');
	const repoManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	const installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
	assert.equal(installedManifest.version, repoManifest.version, 'the installed plugin version must be this checkout');
	assert.ok(installedManifest.exports?.['./bind'] !== undefined, 'the installed plugin must be the 0.4.0 shape with the ./bind export');
	for (const relative of PROVENANCE_FILES) {
		const inRepo = readFileSync(join(ROOT, relative), 'utf8');
		const installed = readFileSync(join(installedDir, relative), 'utf8');
		assert.equal(sha256(installed), sha256(inRepo), `${relative} in the profile must be byte-identical to this checkout`);
	}
	note(`  ${PLUGIN_NAME}@${installedManifest.version}: ${PROVENANCE_FILES.join(', ')} match this checkout`);

	return { tarball, hostDir, dshBin };
}

/** Run the whole acceptance, tearing every child down on the way out. */
async function main() {
	const work = mkdtempSync(join(tmpdir(), 'dsh-web-lan-runtime-'));
	const counters = { boots: 0, checks: 0 };
	note(`temp workspace: ${work}`);
	note(`live GUI at ${process.env.DSH_WEB_URL ?? `http://127.0.0.1:${String(LIVE_GUI_PORT)}`} is never contacted; every child gets its own HOME and DSH_HOME`);
	try {
		const { hostDir, dshBin } = prepare(work);
		const address = firstExternalIpv4();
		const scenarioBase = { work, hostDir, dshBin, counters };
		note(`this machine's first non-internal IPv4: ${address}`);

		phase('bind precedence and refusals');
		// Highest priority: the invocation's own --host, on a concrete local address.
		await scenario({ ...scenarioBase, label: '--host <concrete IPv4>', args: ['--host', address], expectHost: address, expectFlag: true, full: true });
		// The explicit loopback address, with the single-machine flag value.
		await scenario({ ...scenarioBase, label: '--host 127.0.0.1', args: ['--host', '127.0.0.1'], expectHost: '127.0.0.1', expectFlag: false, full: true });
		// --host outranks the loopback escape hatch.
		await scenario({ ...scenarioBase, label: '--host <concrete IPv4> over DSH_WEB_LOOPBACK=1', args: ['--host', address], env: { DSH_WEB_LOOPBACK: '1' }, expectHost: address, expectFlag: true });
		// The escape hatch outranks the deployment variable.
		await scenario({ ...scenarioBase, label: 'DSH_WEB_LOOPBACK=1 over DSH_WEB_HOST', env: { DSH_WEB_LOOPBACK: '1', DSH_WEB_HOST: address }, expectHost: '127.0.0.1', expectFlag: false });
		// The deployment variable outranks the automatic choice.
		await scenario({ ...scenarioBase, label: 'DSH_WEB_HOST=<concrete IPv4>', env: { DSH_WEB_HOST: address }, expectHost: address, expectFlag: true });
		// Nothing named: the first non-internal IPv4.
		await scenario({ ...scenarioBase, label: 'automatic (no knob)', expectHost: address, expectFlag: true });

		phase('explicit addresses that must be refused');
		expectRefusal({ ...scenarioBase, label: '--host 0.0.0.0 (wildcard CLI)', args: ['--host', '0.0.0.0'], pattern: /unspecified \(wildcard\) address/u });
		expectRefusal({ ...scenarioBase, label: 'DSH_WEB_HOST=0.0.0.0 (wildcard env)', env: { DSH_WEB_HOST: '0.0.0.0' }, pattern: /unspecified \(wildcard\) address/u });
		expectRefusal({ ...scenarioBase, label: 'DSH_WEB_HOST= (blank)', env: { DSH_WEB_HOST: '' }, pattern: /is not a concrete IPv4 or IPv6 address literal/u });
		expectRefusal({ ...scenarioBase, label: '--host 10.99.99.99 (not this machine)', args: ['--host', '10.99.99.99'], pattern: /is not an address of this machine/u });

		phase('summary');
		for (const row of summary) note(`  ${row.result.padEnd(20)} ${row.scenario} -> ${row.host}:${String(row.port)}`);
		note(`\nREAL RUNTIME ACCEPTANCE PASSED: ${String(counters.boots)} boots, ${String(counters.checks)} assertions, DSH ${DSH_VERSION}`);
	} finally {
		for (const instance of [...live]) {
			try {
				await stop(instance);
			} catch (error) {
				note(`teardown warning: ${String(error)}`);
			}
		}
		if (process.env.DSH_LAN_KEEP === '1') note(`kept temp workspace: ${work}`);
		else rmSync(work, { recursive: true, force: true });
	}
}

await main();
