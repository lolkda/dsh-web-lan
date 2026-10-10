import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * @lolkda/dsh-web-lan/bind — the concrete listen address this deployment binds.
 *
 * DSH 0.2.1-alpha.2 refuses a wildcard bind in two places: `--host 0.0.0.0` is a
 * usage error in `dsh-web-app/lib/startup.js`, and the webserver's own config
 * schema rejects an unspecified address because a web panel that equals remote
 * code execution must not answer on every interface. The bundle therefore has
 * to name ONE local address *before* the webserver row is created.
 *
 * That address is resolved here and published as the `webLanBind` service; the
 * webserver row patches its `host` from `ctx.webLanBind.host` and injects this
 * service, so the resolution happens at Loader activation, after `webStartup`
 * (the parsed `dsh --profile web` flags) exists.
 *
 * Precedence, highest first:
 *   1. `--host`      — `ctx.webStartup.host`, the invocation's own choice.
 *   2. `DSH_WEB_LOOPBACK=1` — the single-machine escape hatch, always 127.0.0.1.
 *   3. `DSH_WEB_HOST` — a deployment address for launchers that pass no flags.
 *   4. auto          — the first non-internal IPv4 in `os.networkInterfaces()`
 *                      order, the same enumeration the old wildcard bind served.
 *   5. no IPv4 at all — 127.0.0.1 with an explicit warning; never a wildcard.
 *
 * An explicitly named address (1 and 3) is validated instead of trusted: a
 * wildcard, a non-literal, or an address this machine does not own is refused
 * outright, because the failure modes of guessing are a silent localhost-only
 * server or a listen that dies with EADDRNOTAVAIL. Only an ABSENT knob falls
 * through to the next branch — a knob that is present but blank or malformed is
 * a misconfiguration and stops the boot, never a quiet downgrade. Loopback
 * stays allowed (as `127.0.0.1` or `::1`), and a concrete IPv6 literal is
 * accepted — URL shaping for it (brackets) is the web runtime's job, not this
 * service's.
 *
 * Deliberately imports nothing but `node:net` and `node:os`: a `link:`-installed
 * plugin resolves its imports against its real path, so a bare checkout with no
 * `node_modules` still loads.
 *
 * @module @lolkda/dsh-web-lan/bind
 */

/** Stable Cordis plugin name. */
export const name = 'web-lan-bind';

/** The service the webserver row injects to read the resolved address. */
const SERVICE = 'webLanBind';

/** Services that must exist before the flags can be read. */
export const inject = ['webStartup'];

/** The IPv4 loopback literal used for the escape hatch and the no-IPv4 fallback. */
const LOOPBACK = '127.0.0.1';

/** Canonical (fully expanded) wildcard and loopback texts this resolver compares against. */
const WILDCARD_IPV4 = '0.0.0.0';
const WILDCARD_IPV6 = '0000:0000:0000:0000:0000:0000:0000:0000';
const LOOPBACK_IPV6 = '0000:0000:0000:0000:0000:0000:0000:0001';

/**
 * Expand the IPv4 tail of a mixed-notation group (`::0.0.0.1`, `1:2:3:4:5:6:127.0.0.1`)
 * into the two hex groups holding the same bytes, then split the text into
 * groups. `node:net`'s own `isIP` already accepted the value, so the shape is
 * known-good here.
 * @param text - one colon-separated group.
 * @returns one or two lowercase four-digit hex groups.
 */
function ipv6Groups(text) {
	if (!text.includes('.')) return [text.padStart(4, '0')];
	const [a = 0, b = 0, c = 0, d = 0] = text.split('.').map(Number);
	return [(a << 8 | b).toString(16).padStart(4, '0'), (c << 8 | d).toString(16).padStart(4, '0')];
}

/**
 * Expand an IPv6 literal to its eight four-digit groups, so two spellings of one
 * address compare equal and the all-zero check does not miss `::`.
 * @param address - an IPv6 literal accepted by `node:net`.
 * @returns the eight lowercase hex groups.
 */
function expandIpv6(address) {
	const lower = address.toLowerCase();
	const at = lower.indexOf('::');
	if (at === -1) return lower.split(':').flatMap(ipv6Groups);
	const head = lower.slice(0, at) === '' ? [] : lower.slice(0, at).split(':').flatMap(ipv6Groups);
	const tail = lower.slice(at + 2) === '' ? [] : lower.slice(at + 2).split(':').flatMap(ipv6Groups);
	return [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0000'), ...tail];
}

/**
 * Canonical text of one IP literal, used for equality between a requested
 * address and an interface address. IPv4 reads as a dotted quad; IPv6 reads as
 * its eight expanded groups, with the IPv4-mapped form (`::ffff:a.b.c.d`)
 * folded back to the IPv4 address `listen` actually binds. A `%zone` selects an
 * interface and is never address text, so it comes off — but only after
 * `node:net` accepted the whole value, which is the same order the webserver's
 * own schema validates in, so `127.0.0.1%junk` is no literal here either.
 * @param host - candidate address text.
 * @returns the canonical text, or `undefined` when `host` is no IP literal.
 */
export function canonicalAddress(host) {
	if (typeof host !== 'string' || isIP(host) === 0) return undefined;
	const zoneAt = host.indexOf('%');
	const address = zoneAt === -1 ? host : host.slice(0, zoneAt);
	const family = isIP(address);
	if (family === 4) return address;
	if (family !== 6) return undefined;
	const groups = expandIpv6(address);
	// ::ffff:a.b.c.d, the only mapped form `listen` reads as IPv4.
	if (groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff') {
		const high = Number.parseInt(groups[6], 16);
		const low = Number.parseInt(groups[7], 16);
		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
	}
	return groups.join(':');
}

/**
 * Whether a canonical address is a wildcard (every interface) bind.
 * @param address - canonical address text.
 * @returns true for IPv4 any and IPv6 any, including the mapped IPv4 form.
 */
function isWildcard(address) {
	return address === WILDCARD_IPV4 || address === WILDCARD_IPV6;
}

/**
 * Whether a canonical address names loopback.
 * @param address - canonical address text.
 * @returns true for 127/8 and `::1`.
 */
function isLoopback(address) {
	return address.split('.')[0] === '127' || address === LOOPBACK_IPV6;
}

/**
 * Every canonical address of every interface, internal ones included: loopback
 * has to validate, and the set is what an explicitly named address is checked
 * against.
 * @param interfaces - `os.networkInterfaces()`-shaped data.
 * @returns the canonical addresses this machine owns.
 */
function localAddresses(interfaces) {
	const addresses = [];
	for (const list of Object.values(interfaces ?? {})) {
		for (const iface of list ?? []) {
			const address = canonicalAddress(iface?.address);
			if (address !== undefined) addresses.push(address);
		}
	}
	return addresses;
}

/**
 * The first non-internal IPv4 in enumeration order — the address the old
 * wildcard bind made reachable, and the one `dsh-web-lan` already reports.
 * @param interfaces - `os.networkInterfaces()`-shaped data.
 * @returns the address literal, or `undefined` when there is none.
 */
function firstExternalIpv4(interfaces) {
	for (const list of Object.values(interfaces ?? {})) {
		for (const iface of list ?? []) {
			if (iface?.internal !== true && (iface?.family === 'IPv4' || iface?.family === 4)) return iface.address;
		}
	}
	return undefined;
}

/**
 * Validate one explicitly named address instead of trusting it.
 * @param host - the literal as the caller wrote it; kept verbatim on success.
 * @param field - the knob being validated, for the diagnostic (`--host` or `DSH_WEB_HOST`).
 * @param source - the winning branch's name, carried into the result.
 * @param interfaces - `os.networkInterfaces()`-shaped data.
 * @returns the accepted `{ host, source }`.
 * @throws when the value is not an IP literal (blank and non-string included), is a wildcard, or is not local.
 */
function explicitHost(host, field, source, interfaces) {
	const address = canonicalAddress(host);
	if (address === undefined) {
		throw new Error(`web-lan-bind: ${field} ${JSON.stringify(host)} is not a concrete IPv4 or IPv6 address literal`);
	}
	if (isWildcard(address)) {
		throw new Error(
			`web-lan-bind: ${field} ${JSON.stringify(host)} is an unspecified (wildcard) address, which is not supported: `
			+ 'binding every interface would expose this panel to the whole network. Name one concrete address of a local '
			+ `interface, or leave ${field} unset to auto-select the first non-internal IPv4.`
		);
	}
	if (isLoopback(address) || localAddresses(interfaces).includes(address)) return { host, source };
	const available = localAddresses(interfaces).join(', ');
	throw new Error(
		`web-lan-bind: ${field} ${JSON.stringify(host)} is not an address of this machine; this machine has ${available.length === 0 ? 'none' : available}`
	);
}

/**
 * Resolve the one address the webserver will bind, from the invocation flags,
 * the environment, and this machine's interfaces.
 * @param options - resolution inputs; every field is optional.
 * @param options.startupHost - `ctx.webStartup.host`, present only when `--host` was passed.
 * @param options.env - environment to read (`DSH_WEB_LOOPBACK`, `DSH_WEB_HOST`).
 * @param options.interfaces - `os.networkInterfaces()`-shaped data; injectable so the branches stay reproducible.
 * @returns the accepted `{ host, source, warning? }`; `source` names the winning branch.
 * @throws when a knob is present but a wildcard, a non-literal (blank included), or not local; absence is the only default.
 */
export function resolveBindHost(options = {}) {
	const env = options.env ?? process.env;
	const interfaces = options.interfaces ?? networkInterfaces();
	// Presence, not truthiness: only `undefined` means "not asked for". A blank or
	// malformed value is refused by explicitHost rather than quietly skipped.
	if (options.startupHost !== undefined) return explicitHost(options.startupHost, '--host', 'cli', interfaces);
	if (env.DSH_WEB_LOOPBACK === '1') return { host: LOOPBACK, source: 'loopback' };
	if (env.DSH_WEB_HOST !== undefined) return explicitHost(env.DSH_WEB_HOST, 'DSH_WEB_HOST', 'env', interfaces);
	const automatic = firstExternalIpv4(interfaces);
	if (automatic !== undefined) return { host: automatic, source: 'auto' };
	return {
		host: LOOPBACK,
		source: 'fallback',
		warning: 'web-lan-bind: this machine has no non-internal IPv4 address, so the server binds 127.0.0.1 and stays '
			+ 'reachable from this machine only. Name an address explicitly (DSH_WEB_HOST, or --host on the dsh command) '
			+ 'to serve a network.'
	};
}

/**
 * Publish one resolved address and say which one won. Split from {@link apply}
 * so the reporting seam stays verifiable on a machine that always has a
 * non-internal IPv4 address (the fallback branch needs an interface-free host).
 * @param ctx - the plugin context carrying `logger`.
 * @param resolved - a {@link resolveBindHost} result.
 */
export function publishBind(ctx, resolved) {
	if (resolved.warning !== undefined) ctx.logger?.warn?.(resolved.warning);
	ctx.provide(SERVICE, { host: resolved.host });
	ctx.logger?.info?.(`web-lan-bind: listening on ${resolved.host} (${resolved.source})`);
}

/**
 * Resolve the bind address and publish it for the webserver row.
 * @param ctx - the plugin context carrying `webStartup` and `logger`.
 */
export function apply(ctx) {
	publishBind(ctx, resolveBindHost({ startupHost: ctx.webStartup?.host }));
}
