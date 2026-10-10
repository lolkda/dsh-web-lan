import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * @lolkda/dsh-web-lan — the host half. LAN reporting, optional bootstrap, and
 * the browser settings opt-in:
 *
 * 1. Report where this listener is actually reachable. The bound address comes
 *    from `webServer`, never from re-deriving it out of `os.networkInterfaces()`
 *    for a concrete bind: a URL for an interface the socket did not bind looks
 *    alive and is dead. A concrete non-loopback literal is the LAN / virtual LAN
 *    / VPN address another device opens; a loopback literal is reported as
 *    local-only; an IPv6 literal is bracketed. Only a legacy all-interfaces bind
 *    — one an older host's webserver schema still accepts — serves every
 *    interface, and only then are this machine's non-internal IPv4 addresses
 *    listed, because only then does the socket really answer on all of them.
 *
 * 2. Optionally register a token-free bootstrap entry (config `autoLogin`).
 *    `GET <bootstrapPath>` mints the browser-session cookie by redirecting to
 *    `connection.authenticatedUrl(...)`, which is the only public way to read
 *    this process's launch token. The route is registered in the webserver's
 *    `exact` table, which is consulted before the `fallback` seat that
 *    frontend-static owns, so the SPA cannot shadow it. The redirect and every
 *    printed URL carry the scheme `webServer.protocol` reports, so an HTTPS
 *    listener never hands the launch token to an `http://` URL.
 *
 * 3. Publish the LAN settings opt-in through the authenticated index injection
 *    contract. The client half owns its separate, reversible settings provider.
 *
 * Deliberately imports nothing but `node:` builtins (`node:os`, `node:net`): a
 * `link:`-installed plugin resolves its imports against its real path, so a
 * bare checkout with no `node_modules` still loads. The loopback and
 * all-interfaces predicates below mirror `@deepseek-ai/dsh-host-webserver`'s
 * exported `isLoopbackHost` / `isWildcardHost` for the same reason, so the
 * plugin and the listener agree on what a bind literal means. Config is
 * validated by hand for that too.
 *
 * @module @lolkda/dsh-web-lan
 */

/** Stable Cordis plugin name. */
export const name = 'web-lan';

/** Default path of the token-free entry registered when `autoLogin` is on. */
const DEFAULT_BOOTSTRAP_PATH = '/go';

/** Services that must exist before the reporting and the entry can be mounted. */
export const inject = ['webServer', 'connection'];

/** Dotted-quad tail of the mixed IPv6 notation: `::0.0.0.1`, `1:2:3:4:5:6:127.0.0.1`. */
const IPV4_TAIL = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Every non-internal IPv4 address of this machine, in `os.networkInterfaces()`
 * order. Only a legacy all-interfaces bind serves them all; a concrete bind
 * serves exactly the literal it names.
 * @returns the LAN/VPN-reachable IPv4 address literals.
 */
export function ipv4Addresses() {
	const addresses = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
		}
	}
	return addresses;
}

/**
 * Bind text, or the empty string for a value that is not a literal at all.
 * @param host - bind value from the webserver config.
 * @returns the address text to parse.
 */
function bindText(host) {
	return typeof host === 'string' ? host : '';
}

/**
 * Drop a trailing `%zone` interface selector. A zone picks a local interface
 * and is never address text, so it is not part of a URL host either. `node:net`
 * accepts a zone only on an IPv6 literal — `127.0.0.1%lo` is no literal at all —
 * and the host's own bind parser reads it the same way.
 * @param host - address text that may end in `%<zone>`.
 * @returns the bare address text.
 */
function withoutZone(host) {
	if (isIP(host) === 0) return host;
	const zoneAt = host.indexOf('%');
	return zoneAt === -1 ? host : host.slice(0, zoneAt);
}

/**
 * Rewrite a dotted-quad tail as the two hex groups holding the same 16 bits, so
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` read identically. `listen` reads that
 * tail as the low 32 bits of the address, and the words must agree with it.
 * @param text - IPv6 text, optionally ending in a dotted quad.
 * @returns the same address with a hex tail.
 */
function hexTail(text) {
	const tail = IPV4_TAIL.exec(text);
	if (tail === null) return text;
	const [, head = '', a = '', b = '', c = '', d = ''] = tail;
	return `${head}${(Number(a) << 8 | Number(b)).toString(16)}:${(Number(c) << 8 | Number(d)).toString(16)}`;
}

/**
 * The eight 16-bit words of an IPv6 literal, in network order.
 * @param text - address text without a zone.
 * @returns the words, or undefined when `text` is no IPv6 literal.
 */
function ipv6Words(text) {
	const hex = hexTail(text);
	if (isIP(hex) !== 6) return undefined;
	const [head = '', tail, ...extra] = hex.split('::');
	if (extra.length > 0) return undefined;
	const left = head === '' ? [] : head.split(':').map((word) => Number.parseInt(word, 16));
	const right = tail === undefined || tail === '' ? [] : tail.split(':').map((word) => Number.parseInt(word, 16));
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
	return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * The IPv4 address an IPv4-mapped IPv6 address carries, or undefined when the
 * words are not a mapped address.
 * @param words - the eight words of an IPv6 literal.
 * @returns the mapped words as `[high, low]`, or undefined.
 */
function mappedWords(words) {
	const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
	return mapped ? [words[6], words[7]] : undefined;
}

/**
 * Whether a bind literal names the loopback authority: any address in 127/8,
 * `::1`, and their IPv4-mapped forms. Mirrors the webserver's own predicate, so
 * the plugin and the listener agree on what "this machine only" means.
 * @param host - bind value from the webserver config.
 * @returns true when no other device can reach the listener.
 */
function isLoopbackBind(host) {
	const bare = withoutZone(bindText(host));
	if (isIP(bare) === 4) return bare.startsWith('127.');
	const words = ipv6Words(bare);
	if (words === undefined) return false;
	const mapped = mappedWords(words);
	if (mapped !== undefined) return (mapped[0] >> 8) === 0x7f;
	return words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
}

/**
 * Whether a bind literal asks for every interface at once: IPv4 any, IPv6 any,
 * or a mapped form of IPv4 any. DSH 0.2.1-alpha.2 and later reject these at
 * load, so observing one means the row was written for an older host — where
 * the socket really does answer on every interface.
 * @param host - bind value from the webserver config.
 * @returns true for an all-interfaces bind.
 */
function isAllInterfacesBind(host) {
	const bare = withoutZone(bindText(host));
	if (isIP(bare) === 4) return bare.split('.').every((octet) => Number(octet) === 0);
	const words = ipv6Words(bare);
	if (words === undefined) return false;
	if (words.every((word) => word === 0)) return true;
	const mapped = mappedWords(words);
	return mapped !== undefined && mapped[0] === 0 && mapped[1] === 0;
}

/**
 * Host text that is valid inside a URL: brackets for IPv6, and no zone.
 * @param host - bind literal.
 * @returns host text for a `scheme://host:port` URL.
 */
function urlHost(host) {
	const bare = withoutZone(bindText(host));
	return isIP(bare) === 6 ? `[${bare}]` : bare;
}

/**
 * The scheme this listener serves. DSH 0.2.1-alpha.2 and later expose
 * `webServer.protocol`, and there it is authoritative: it follows the
 * listener's configuration — its TLS material, never a socket, a proxy, or a
 * request header. A host that exposes no such getter reports no scheme at all,
 * so the only available compatibility default is `'http:'`: that is a missing
 * signal, not a claim that such a host serves plain HTTP.
 * @param webServer - the injected webserver service.
 * @returns `'https:'` only when the getter reports TLS.
 */
function listenerProtocol(webServer) {
	return webServer.protocol === 'https:' ? 'https:' : 'http:';
}

/**
 * Mount LAN reporting and, when enabled, the token-free entry.
 * @param ctx - the plugin context carrying `webServer` and `connection`.
 * @param config - raw row config; every field is optional.
 */
export function apply(ctx, config) {
	const autoLogin = config?.autoLogin === true;
	const printLanUrls = config?.printLanUrls !== false;
	const requested = config?.bootstrapPath;
	const bootstrapPath = typeof requested === 'string' && requested.startsWith('/') ? requested : DEFAULT_BOOTSTRAP_PATH;

	const host = ctx.webServer.host;
	const port = ctx.webServer.port;
	const protocol = listenerProtocol(ctx.webServer);
	// Loopback is the only bind measured as unreachable from another device: any
	// other concrete literal serves the network its address belongs to, and a
	// legacy all-interfaces bind serves them all.
	const loopback = isLoopbackBind(host);
	const allInterfaces = isAllInterfacesBind(host);

	// The browser reads this deployment opt-in before mounting its own settings
	// provider. The normal authenticated index renderer delivers the flag; all
	// reads/writes still go through the original Connection/RPC authentication.
	ctx.on('webserver/index-inject', (rows) => {
		rows.push({
			kind: 'global',
			name: '__DSH_WEB_LAN_SETTINGS__',
			value: !loopback && config?.remoteSettings !== false
		});
	});

	// A loopback bind is a legitimate choice (DSH_WEB_LOOPBACK=1, a --host of
	// 127.0.0.1, or the fallback when this machine has no usable address), but it
	// cannot reach another device, so no LAN address is advertised and the LAN
	// settings opt-in above stays off. Say so rather than leaving a silent
	// difference from a LAN install.
	if (loopback) {
		ctx.logger?.warn?.(
			`web-lan: this server is bound to ${String(host)} (loopback), so it is only reachable from this machine: `
			+ 'no LAN address is advertised and the browser LAN settings stay off. '
			+ 'Bind one concrete local interface address to reach this server from another device.'
		);
	}

	if (autoLogin) {
		const dispose = ctx.webServer.register({
			kind: 'exact',
			path: bootstrapPath,
			handler: (req, res) => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('web-lan: this entry only answers GET and HEAD.\n');
					return;
				}
				// Refuse an untrusted Host: minting a cookie for an authority the /api
				// fence rejects anyway would only look like success.
				if (ctx.connection.requestRejection(req) === 403) {
					res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('web-lan: this Host is not in trustedHosts; no session issued.\n');
					return;
				}
				const authority = req.headers.host;
				if (authority === undefined) {
					res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
					res.end('web-lan: missing Host header.\n');
					return;
				}
				res.writeHead(303, {
					location: ctx.connection.authenticatedUrl(`${protocol}//${authority}/`),
					'cache-control': 'no-store',
					'referrer-policy': 'no-referrer'
				});
				res.end();
			}
		});
		ctx.effect(() => dispose);
	}

	if (printLanUrls) {
		// Print only what this listener serves: the configured bind when it names
		// one interface, this machine's non-internal IPv4 addresses when a legacy
		// host still accepts an all-interfaces bind.
		const addresses = allInterfaces ? ipv4Addresses() : [host];
		const authority = (address) => `${urlHost(address)}:${String(port)}`;
		if (allInterfaces) {
			console.log(`dsh-web-lan: reachable on ${String(host)}:${String(port)}, every interface is bound within ` +
				'家用局域网 / 虚拟局域网 / VPN (open one of these from the other device):');
		} else if (loopback) {
			console.log(`dsh-web-lan: listening on ${authority(host)} — 只有本机能访问 (loopback):`);
		} else {
			console.log(`dsh-web-lan: listening on ${authority(host)} within ` +
				'家用局域网 / 虚拟局域网 / VPN (open it from the other device):');
		}
		for (const address of addresses) {
			const base = `${protocol}//${authority(address)}`;
			// Only the token-free entry is worth printing when autoLogin is on; otherwise the
			// token is the whole point of the line, so hand over the complete URL.
			const url = autoLogin ? `${base}${bootstrapPath}` : ctx.connection.authenticatedUrl(base);
			const label = allInterfaces ? `${address.padEnd(15)} ` : '';
			console.log(`dsh-web-lan:   ${label}${url}`);
		}
		if (autoLogin) {
			console.log('dsh-web-lan: autoLogin 已开启 —— 上面这些地址不需要 token，谁能连到这个端口谁就能进。');
		} else {
			console.log('dsh-web-lan: 每台设备打开上面任意一个地址一次即可；会话 cookie 有效期 3650 天。');
		}
	}
}
