import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as cordis from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';

const require = createRequire(import.meta.url);
export const SETTINGS_PACKAGE = '@deepseek-ai/dsh-client-ui-settings';
export const MODELS_PACKAGE = '@deepseek-ai/dsh-client-ui-settings-models';
export const LAN_PACKAGE = '@lolkda/dsh-web-lan';

// DSH supplies this small observable as a browser-kernel singleton, not an npm
// runtime dependency. The fixture preserves its immutable snapshot contract;
// the settings and Models controllers themselves below are the real bundles.
function createSnapshotStore(initial) {
	let snapshot = initial;
	const listeners = new Set();
	const set = (next) => {
		snapshot = next;
		for (const listener of [...listeners]) listener();
	};
	return {
		getSnapshot: () => snapshot,
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		set,
		update(change) { const next = structuredClone(snapshot); change(next); set(next); }
	};
}

export async function clientBundle(path, enabled = true) {
	let registration;
	const window = { __ModuleLoader__: { load(value) { registration = value; } } };
	runInNewContext(await readFile(path, 'utf8'), {
		window, console, structuredClone, setTimeout, clearTimeout,
		__DSH_WEB_LAN_SETTINGS__: enabled
	}, { filename: String(path) });
	assert.ok(registration, 'bundle must register through the official module loader');
	return registration.factory((specifier) => {
		if (specifier === '@deepseek-ai/cordis') return cordis;
		if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore };
		// No React component is rendered here: the real Models page controller is
		// obtained through its normal slot registration and exercised directly.
		if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {};
		if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier);
		throw new Error(`unexpected browser dependency: ${specifier}`);
	});
}

export function documentView(value = 'light', revision = 1, writable = true) {
	return {
		writable,
		hasDocument: true,
		namespaces: [{
			ns: 'test-preferences', revision,
			schema: { uid: 0, refs: { 0: { type: 'object', dict: { theme: 1 } }, 1: { type: 'string' } } },
			base: { theme: 'light' }, user: {}, value: { theme: value }
		}]
	};
}

export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

/**
 * Wait until a condition holds, yielding between checks.
 *
 * A fixed number of ticks is a guess that the Loader finished re-applying an
 * entry, and a guess is a flake waiting to happen. This waits on the state the
 * test actually depends on, and says what it was waiting for when it gives up.
 * @param predicate - the condition to wait for.
 * @param description - what to name in the failure.
 * @param timeoutMs - bound on the wait.
 */
async function waitFor(predicate, description, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() >= deadline) throw new Error(`web-lan test: timed out after ${timeoutMs}ms waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export async function browser(t, { loopback = false, enabled = true, parallelBoot = false, describe, mutate } = {}) {
	const ctx = new cordis.Context();
	const events = new Map();
	const slots = new Map();
	const calls = { reads: 0, writes: [] };
	let current = documentView();
	const remote = {
		$host: Object.freeze({ isLoopback: loopback, home: 'fixture-home' }),
		$on(event, listener) {
			if (!events.has(event)) events.set(event, new Set());
			events.get(event).add(listener);
			return () => events.get(event).delete(listener);
		},
		settings: {
			async describe() { calls.reads++; return describe ? describe() : { ok: true, value: current }; },
			async mutate(namespace, operations, revision) {
				calls.writes.push({ namespace, operations: structuredClone(operations), revision });
				if (mutate) return mutate(namespace, operations, revision);
				const value = { ...current.namespaces[0].value };
				for (const operation of operations) {
					if (operation.op === 'set') value[operation.path[0]] = operation.value;
					else delete value[operation.path[0]];
				}
				const row = { ...current.namespaces[0], revision: current.namespaces[0].revision + 1, value };
				current = { ...current, namespaces: [row] };
				return { ok: true, value: row };
			}
		},
		llm: {
			listProviders: async () => ({ ok: true, value: [] }),
			listConfigurableProviders: async () => ({ ok: true, value: [] })
		},
		credentials: { describe: async () => ({ ok: true, value: {} }) }
	};
	class Slots extends cordis.Service {
		constructor(c) { super(c, 'slots'); }
		inject(_name, factory) { return this.ctx.effect(factory); }
		register(slot) {
			slots.set(slot.id, slot);
			return () => { if (slots.get(slot.id) === slot) slots.delete(slot.id); };
		}
	}
	const services = ctx.plugin({ name: 'browser-test-boundaries', apply(c) {
		c.provide('remote', remote);
		for (const key of ['settings', 'llm', 'credentials']) c.provide(`remote.${key}`, remote[key]);
		c.provide('locale', { register: () => () => {}, bind: () => (key) => key });
		new Slots(c);
	} });
	await services.await();
	await ctx.plugin(Loader).await();
	const loader = ctx.get('loader');
	const modules = new Map([
		[SETTINGS_PACKAGE, await clientBundle(require.resolve(`${SETTINGS_PACKAGE}/client`))],
		[MODELS_PACKAGE, await clientBundle(require.resolve(`${MODELS_PACKAGE}/client`))],
		[LAN_PACKAGE, await clientBundle(new URL('../lib/client.js', import.meta.url), enabled)]
	]);
	loader.internal = { version: 'client', async import(name) {
		if (!modules.has(name)) throw new Error(`unknown test module: ${name}`);
		return modules.get(name);
	} };

	if (parallelBoot) {
		await Promise.all([
			loader.create({ id: 'upstream-settings', name: SETTINGS_PACKAGE }),
			loader.create({ id: 'models', name: MODELS_PACKAGE }),
			loader.create({ id: 'lan', name: LAN_PACKAGE })
		]);
	} else {
		await loader.create({ id: 'upstream-settings', name: SETTINGS_PACKAGE });
		await loader.create({ id: 'models', name: MODELS_PACKAGE });
	}
	await loader.await();
	t.after(async () => { await ctx.fiber.dispose(); });
	return {
		ctx, loader, calls, remote,
		original: ctx.get('configForms'),
		models() { return slots.get('models').inject().controller; },
		mirror() { return ctx.get('configForms').describe(); },
		setDocument(value) { current = value; },
		emit(event) { for (const listener of [...events.get(event) ?? []]) listener(); },
		waitFor,
		/**
		 * Wait until the LAN provider, its describe read, and the Models page are
		 * all live again.
		 *
		 * A sibling entry that reloads re-applies the LAN entry behind it, and the
		 * provider that entry mounts is asynchronous by design: `loader.await()`
		 * resolves before that tail. This is the observable state a test needs
		 * after a reload, rather than a fixed number of ticks.
		 * @param options - optional wait bound.
		 */
		async ready({ timeoutMs = 2000 } = {}) {
			await waitFor(
				() => {
					const forms = ctx.get('configForms');
					return forms !== undefined
						&& forms.describe().getSnapshot().status === 'ready'
						&& slots.has('models');
				},
				'the LAN settings provider, its describe read, and the Models page to be live',
				timeoutMs,
			);
		},
		async install() {
			await loader.create({ id: 'lan', name: LAN_PACKAGE });
			await loader.await();
		},
		async uninstall() { await loader.remove('lan'); await loader.await(); },
		/**
		 * One consumer's form, taken the way a settings consumer takes it on DSH
		 * 0.1.7: `configForms.get(entryId)`, where the entry id is also the
		 * namespace. The form is cached per namespace, so two calls for the same
		 * namespace share one write queue.
		 * @param entryId - the Host entry id / namespace to read.
		 * @returns the form and a disposer for the consumer's own lifecycle.
		 */
		async scope(entryId = 'test-preferences') {
			let form;
			const fiber = ctx.plugin({ name: 'settings-consumer', inject: ['configForms'], apply(c) {
				form = c.configForms.get(entryId);
			} });
			await fiber.await();
			await ctx.get('configForms').describe().ensure();
			return { get current() { return form; }, dispose: () => fiber.dispose() };
		}
	};
}
