import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('ships a web client extension for LAN settings', () => {
	assert.equal(packageJson.exports['./client'], './lib/client.js');
	assert.equal(packageJson.dsh.client?.platform, 'web');
	assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
});

// These tests run the unmodified upstream settings and Models page controllers
// inside a real Cordis + Loader lifecycle. Only the network and UI boundaries
// are in-memory fixtures; no running DSH instance or user settings are touched.
const { browser, documentView, deferred } = await import('../test-utils/client-runtime.js');

test('reproduces the upstream Models error on a non-loopback page', async (t) => {
	const b = await browser(t);
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().error, 'settings are unavailable in this browser');
	assert.equal(b.calls.reads, 0);
});

test('LAN extension makes the existing Models page ready without falsifying loopback', async (t) => {
	const b = await browser(t);
	const upstream = b.original.describe();
	await b.install();
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().status, 'ready');
	assert.equal(b.models().store.getSnapshot().error, null);
	assert.equal(b.remote.$host.isLoopback, false);
	assert.equal(upstream.getSnapshot().status, 'unavailable', 'upstream internals remain untouched');
	assert.equal(b.mirror().getSnapshot().view.namespaces[0].value.theme, 'light');
});

test('localhost keeps the original settings provider', async (t) => {
	const b = await browser(t, { loopback: true });
	await b.install();
	assert.equal(b.mirror().getSnapshot(), b.original.describe().getSnapshot());
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().status, 'ready');
});

test('explicitly disabled LAN settings leaves upstream behavior intact', async (t) => {
	const b = await browser(t, { enabled: false });
	await b.install();
	assert.equal(b.mirror().getSnapshot(), b.original.describe().getSnapshot());
	assert.equal(b.calls.reads, 0);
});

test('uninstall restores the original service and permits a clean reinstall', async (t) => {
	const b = await browser(t);
	await b.install();
	assert.equal(b.mirror().getSnapshot().status, 'ready');
	await b.uninstall();
	assert.equal(b.mirror().getSnapshot().status, 'unavailable');
	assert.equal(b.loader.resolve('upstream-settings').options.isolate, undefined);
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().error, 'settings are unavailable in this browser');
	await b.install();
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().status, 'ready');
});

test('a form reads and persists through the existing settings RPC', async (t) => {
	const b = await browser(t);
	await b.install();
	const consumer = await b.scope();
	assert.equal(consumer.current.getSnapshot().mode, 'host');
	assert.equal(consumer.current.getSnapshot().value.theme, 'light');
	await consumer.current.set('theme', 'dark');
	assert.equal(b.calls.writes.length, 1);
	assert.equal(b.calls.writes[0].namespace, 'test-preferences');
	assert.equal(b.calls.writes[0].revision, 1);
	assert.equal(consumer.current.getSnapshot().value.theme, 'dark');
	assert.equal(consumer.current.getSnapshot().revision, 2);
	// 0.1.7's forms belong to the provider, not to the fiber that asked for one:
	// `configForms.get` caches by namespace so two editors share one write queue,
	// and only the provider's teardown stops that queue.
	await consumer.dispose();
	await consumer.current.set('theme', 'after-unmount');
	assert.equal(b.calls.writes.length, 2, 'a form outlives the consumer fiber that asked for it');
	await b.uninstall();
	await consumer.current.set('theme', 'after-uninstall');
	assert.equal(b.calls.writes.length, 2, 'uninstalling the provider disposes every form it handed out');
});

test('backend authorization errors stay errors instead of fabricated settings', async (t) => {
	const b = await browser(t, { describe: async () => ({ ok: false, error: { message: 'unauthorized' } }) });
	await b.install();
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().status, 'error');
	assert.equal(b.models().store.getSnapshot().error, 'unauthorized');
	assert.equal(b.mirror().getSnapshot().view, undefined);
	assert.equal(b.remote.$host.isLoopback, false);
});

test('pushed changes refresh all scopes from one shared document', async (t) => {
	const b = await browser(t);
	await b.install();
	const first = await b.scope();
	const second = await b.scope();
	const before = b.calls.reads;
	b.setDocument(documentView('changed-elsewhere', 5));
	b.emit('settings/document-updated');
	await b.mirror().ensure();
	assert.equal(b.calls.reads, before + 1);
	assert.equal(first.current.getSnapshot().value.theme, 'changed-elsewhere');
	assert.equal(second.current.getSnapshot().revision, 5);
});

test('an invalidation during an in-flight read is not lost', async (t) => {
	const started = deferred();
	const slow = deferred();
	let reads = 0;
	const b = await browser(t, { describe: async () => {
		reads++;
		if (reads === 2) { started.resolve(); return slow.promise; }
		return { ok: true, value: documentView(reads === 1 ? 'initial' : 'newest', reads) };
	} });
	await b.install();
	await b.mirror().ensure();
	b.emit('settings/document-updated');
	await started.promise;
	b.emit('settings/document-updated');
	slow.resolve({ ok: true, value: documentView('older', 2) });
	await b.mirror().ensure();
	assert.equal(reads, 3);
	assert.equal(b.mirror().getSnapshot().view.namespaces[0].value.theme, 'newest');
});

test('an older read cannot overwrite an accepted write answer', async (t) => {
	const started = deferred();
	const slow = deferred();
	let reads = 0;
	const b = await browser(t, { describe: async () => {
		if (++reads === 2) { started.resolve(); return slow.promise; }
		return { ok: true, value: documentView(reads === 1 ? 'initial' : 'saved', reads === 1 ? 1 : 3) };
	} });
	await b.install();
	await b.mirror().ensure();
	b.emit('settings/document-updated');
	await started.promise;
	b.mirror().acceptView(documentView('saved', 3).namespaces[0]);
	slow.resolve({ ok: true, value: documentView('stale', 1) });
	await b.mirror().ensure();
	assert.equal(b.mirror().getSnapshot().view.namespaces[0].value.theme, 'saved');
	assert.equal(b.mirror().getSnapshot().view.namespaces[0].revision, 3);
});

test('rapid writes preserve revision order and publish only the latest answer', async (t) => {
	const started = deferred();
	const first = deferred();
	let writes = 0;
	const b = await browser(t, { mutate: async () => {
		if (++writes === 1) { started.resolve(); return first.promise; }
		return { ok: true, value: documentView('last', 3).namespaces[0] };
	} });
	await b.install();
	const consumer = await b.scope();
	const seen = [];
	consumer.current.subscribe(() => seen.push(consumer.current.getSnapshot().value.theme));
	const a = consumer.current.set('theme', 'first');
	const z = consumer.current.set('theme', 'last');
	await started.promise;
	first.resolve({ ok: true, value: documentView('first', 2).namespaces[0] });
	await Promise.all([a, z]);
	assert.deepEqual(b.calls.writes.map((write) => write.revision), [1, 2]);
	assert.equal(seen.includes('first'), false);
	assert.equal(consumer.current.getSnapshot().value.theme, 'last');
});

test('settings provider reload does not duplicate services or strand consumers', { timeout: 3000 }, async (t) => {
	const b = await browser(t);
	await b.install();
	await b.loader.resolve('upstream-settings').update({ config: { reloadProbe: true } });
	await b.loader.await();
	// The reload re-applies the LAN entry behind it, and the provider that entry
	// mounts is asynchronous; wait for the state this test actually depends on.
	await b.ready();
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().status, 'ready');
	assert.equal(b.remote.$host.isLoopback, false);
});

test('default schema validation supports ordinary preference consumers', async (t) => {
	const b = await browser(t);
	await b.install();
	const consumer = await b.scope('test-preferences');
	assert.equal(consumer.current.getSnapshot().status, 'ready');
	assert.equal(consumer.current.getSnapshot().value.theme, 'light');
});

test('read-only backend settings never cause a mutation request', async (t) => {
	const b = await browser(t, { describe: async () => ({ ok: true, value: documentView('locked', 1, false) }) });
	await b.install();
	const consumer = await b.scope();
	assert.equal(consumer.current.getSnapshot().writable, false);
	await consumer.current.set('theme', 'forbidden');
	assert.equal(b.calls.writes.length, 0);
	assert.equal(consumer.current.getSnapshot().value.theme, 'locked');
});

test('a rejected write reloads the authoritative backend state', async (t) => {
	const b = await browser(t, { mutate: async () => ({ ok: false, error: { message: 'revision conflict' } }) });
	await b.install();
	const consumer = await b.scope();
	b.setDocument(documentView('other-device', 8));
	await consumer.current.set('theme', 'outdated-edit');
	assert.equal(consumer.current.getSnapshot().value.theme, 'other-device');
	assert.equal(consumer.current.getSnapshot().revision, 8);
});

test('an explicit revision fence is preserved and caller operations are copied', async (t) => {
	const b = await browser(t);
	await b.install();
	const consumer = await b.scope();
	const operations = [{ op: 'set', path: ['theme'], value: 'selected' }];
	const saved = consumer.current.mutate(operations, 17);
	operations[0].value = 'mutated-by-caller';
	await saved;
	assert.equal(b.calls.writes[0].revision, 17);
	assert.equal(b.calls.writes[0].operations[0].value, 'selected');
});

test('unknown namespaces stay unavailable and a refused section keeps the accepted value', async (t) => {
	const b = await browser(t);
	await b.install();
	const unknown = await b.scope('not-exposed');
	assert.equal(unknown.current.getSnapshot().status, 'unavailable');
	// 0.1.7's form has no per-consumer decoder: the Host publishes the namespace's
	// own wire schema, and a section that schema refuses must not replace the value
	// the form last accepted.
	const valid = await b.scope('test-preferences');
	b.mirror().acceptView({ ...documentView().namespaces[0], value: { theme: false }, revision: 2 });
	assert.equal(valid.current.getSnapshot().value.theme, 'light');
});

test('a failed refresh retains the last good snapshot', async (t) => {
	let fail = false;
	const b = await browser(t, { describe: async () => {
		if (fail) throw new Error('temporarily disconnected');
		return { ok: true, value: documentView() };
	} });
	await b.install();
	await b.mirror().ensure();
	fail = true;
	b.emit('settings/document-updated');
	await b.mirror().ensure();
	assert.equal(b.mirror().getSnapshot().status, 'ready');
	assert.equal(b.mirror().getSnapshot().view.namespaces[0].value.theme, 'light');
	assert.equal(b.mirror().getSnapshot().error, 'temporarily disconnected');
});

test('official bundles remain byte-identical after install and uninstall', async (t) => {
	const paths = ['@deepseek-ai/dsh-client-ui-settings/client', '@deepseek-ai/dsh-client-ui-settings-models/client'].map((name) => new URL(import.meta.resolve(name)));
	const before = await Promise.all(paths.map((path) => readFile(path)));
	const b = await browser(t);
	await b.install();
	await b.models().load();
	await b.uninstall();
	for (let i = 0; i < paths.length; i++) assert.ok(before[i].equals(await readFile(paths[i])));
});

test('a failed provider setup restores the original row before the entry is retried', async (t) => {
	const b = await browser(t);
	const entry = b.loader.resolve('upstream-settings');
	const update = entry.update.bind(entry);
	/** Every call the plugin made, with the row it observed on entry. */
	const calls = [];
	let refused = false;
	// Inject one failure at the public Loader boundary, after isolation was
	// configured but before the original provider could be started again.
	entry.update = async (options, ...rest) => {
		calls.push({
			options: { ...options },
			isolateBefore: entry.options.isolate === undefined ? undefined : { ...entry.options.isolate },
			disabledBefore: entry.disabled,
		});
		if (!refused && options.disabled === null && entry.options.isolate?.configForms) {
			refused = true;
			throw new Error('fixture start rejected');
		}
		return update(options, ...rest);
	};
	await b.install();
	const refusal = calls.findIndex((call) => call.options.disabled === null && call.isolateBefore?.configForms);
	assert.equal(refused, true, 'the fixture must have refused the first start');
	assert.deepEqual(
		calls[refusal].isolateBefore,
		{ configForms: '@lolkda/dsh-web-lan/original-settings' },
		'the refusal must land with the row isolated',
	);
	// The rollback is the three calls right after the refusal: stop, drop the
	// isolation, start again — the row's own original configuration.
	assert.deepEqual(
		calls.slice(refusal + 1, refusal + 4).map((call) => call.options),
		[{ disabled: true }, { isolate: null }, { disabled: null }],
		'a refused start must be rolled back through the public Loader API',
	);
	const retry = calls[refusal + 4];
	assert.equal(retry.isolateBefore, undefined, 'the rollback must leave no isolation behind');
	assert.equal(retry.disabledBefore, false, 'and the row must be running again before the retry');
	assert.equal(
		calls.filter((call) => call.options.isolate?.configForms).length,
		2,
		'isolation is configured once per attempt: the refused one and the retry',
	);
	assert.equal(entry.disabled, false);
	assert.equal(entry.options.isolate?.configForms, '@lolkda/dsh-web-lan/original-settings');
	assert.equal(b.mirror().getSnapshot().status, 'ready', 'and the retry leaves LAN settings in force');
});

test('parallel browser startup settles with the real Models page ready', { timeout: 3000 }, async (t) => {
	const b = await browser(t, { parallelBoot: true });
	await b.models().load();
	assert.equal(b.models().store.getSnapshot().status, 'ready');
	assert.equal(b.remote.$host.isLoopback, false);
});
