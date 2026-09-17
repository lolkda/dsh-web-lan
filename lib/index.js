import { networkInterfaces } from 'node:os';

/**
 * @lolkda/dsh-web-lan — the host half. Two jobs, both about telling the truth
 * that `dsh-web-app` cannot:
 *
 * 1. Report LAN reachability per interface. `dsh-web-app` prints only
 *    `lanAddresses[0]`, which is whatever `os.networkInterfaces()` enumerates
 *    first — on a machine with a virtual adapter (SD-WAN, VPN, Hyper-V) that is
 *    routinely the wrong (often dead) address. This plugin prints every
 *    non-internal IPv4 with the exact URL to open, token included, so nothing
 *    has to be assembled by hand.
 *
 * 2. Optionally register a token-free bootstrap entry (config `autoLogin`).
 *    `GET <bootstrapPath>` mints the browser-session cookie by redirecting to
 *    `connection.authenticatedUrl(...)`, which is the only public way to read
 *    this process's launch token. The route is registered in the webserver's
 *    `exact` table, which is consulted before the `fallback` seat that
 *    frontend-static owns, so the SPA cannot shadow it.
 *
 * Deliberately imports nothing but `node:os`: a `link:`-installed plugin
 * resolves its imports against its real path, so a bare checkout with no
 * `node_modules` still loads. Config is validated by hand for the same reason.
 *
 * @module @lolkda/dsh-web-lan
 */

/** Stable Cordis plugin name. */
export const name = 'web-lan';

/** The webserver's all-interfaces literal; the only non-loopback bind its schema accepts. */
const ALL_INTERFACES = '0.0.0.0';

/** Default path of the token-free entry registered when `autoLogin` is on. */
const DEFAULT_BOOTSTRAP_PATH = '/go';

/** Services that must exist before the reporting and the entry can be mounted. */
export const inject = ['webServer', 'connection'];

/**
 * Every non-internal IPv4 address of this machine, in `os.networkInterfaces()`
 * order. Mirrors what `dsh-web-app` derives for its trust fence, so the plugin
 * reports exactly the set the fence will accept.
 * @returns the LAN/VPN-reachable address literals.
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

	// The bind lives in the profile patch layer, so a later layer (the profile's own
	// cordis.patch.yml, or a --patch overlay) can override it and silently take this
	// bundle out of play. Say so instead of printing unreachable URLs.
	if (host !== ALL_INTERFACES) {
		ctx.logger?.warn?.(
			`web-lan: this server is bound to ${String(host)}, so it is not reachable from the LAN or a virtual LAN. `
			+ 'A later patch layer replaced the webserver row config — check the profile cordis.patch.yml and any --patch overlay.'
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
					location: ctx.connection.authenticatedUrl(`http://${authority}/`),
					'cache-control': 'no-store',
					'referrer-policy': 'no-referrer'
				});
				res.end();
			}
		});
		ctx.effect(() => dispose);
	}

	if (printLanUrls) {
		const addresses = host === ALL_INTERFACES ? ipv4Addresses() : [host];
		if (host === ALL_INTERFACES) {
			console.log(`dsh-web-lan: reachable on ${ALL_INTERFACES}:${String(port)} within ` +
				'家用局域网 / 虚拟局域网 / VPN (open one of these from the other device):');
		}
		for (const address of addresses) {
			const base = `http://${address}:${String(port)}`;
			// Only the token-free entry is worth printing when autoLogin is on; otherwise the
			// token is the whole point of the line, so hand over the complete URL.
			const url = autoLogin ? `${base}${bootstrapPath}` : ctx.connection.authenticatedUrl(base);
			console.log(`dsh-web-lan:   ${address.padEnd(15)} ${url}`);
		}
		if (autoLogin) {
			console.log('dsh-web-lan: autoLogin 已开启 —— 上面这些地址不需要 token，谁能连到这个端口谁就能进。');
		} else {
			console.log('dsh-web-lan: 每台设备打开上面任意一个地址一次即可；会话 cookie 有效期 3650 天。');
		}
	}
}
