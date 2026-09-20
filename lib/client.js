/**
 * Browser half, in DSH's documented lazy-factory bundle format. No build step
 * or runtime npm dependencies: Cordis is provided by the browser module table.
 * Only public Loader isolation and settings RPC contracts are used here.
 */
window.__ModuleLoader__.load({
	id: '@lolkda/dsh-web-lan',
	factory: (require) => {
		const { Service } = require('@deepseek-ai/cordis');
		const SETTINGS_PACKAGE = '@deepseek-ai/dsh-client-ui-settings';
		const ORIGINAL_SCOPE = '@lolkda/dsh-web-lan/original-settings';

		/** A stable observable snapshot; subscribers never receive mutable drafts. */
		function observable(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				publish(next) {
					snapshot = next;
					for (const listener of [...listeners]) listener();
				},
				clear() { listeners.clear(); }
			};
		}

		/** One shared, host-backed settings.describe reader for all LAN consumers. */
		class SettingsMirror {
			constructor(remote) {
				this.remote = remote;
				this.state = observable({ status: 'idle', view: undefined, error: null });
				this.pending = undefined;
				this.rerun = false;
				this.generation = 0;
				this.closed = false;
			}
			getSnapshot() { return this.state.getSnapshot(); }
			subscribe(listener) { return this.state.subscribe(listener); }
			ensure() {
				if (this.pending) return this.pending;
				return this.getSnapshot().status === 'idle' ? this.load() : Promise.resolve();
			}
			load() {
				if (this.closed) return Promise.resolve();
				if (this.pending) { this.rerun = true; return this.pending; }
				this.pending = Promise.resolve().then(async () => {
					do {
						this.rerun = false;
						const generation = ++this.generation;
						const previous = this.getSnapshot();
						if (!previous.view) this.state.publish({ ...previous, status: 'loading' });
						try {
							const response = await this.remote.settings.describe();
							if (this.closed || generation !== this.generation) continue;
							if (!response.ok) throw new Error(response.error.message);
							this.state.publish({ status: 'ready', view: response.value, error: null });
						} catch (error) {
							if (this.closed || generation !== this.generation) continue;
							const held = this.getSnapshot();
							this.state.publish({ ...held, status: held.view ? 'ready' : 'idle', error: String(error.message ?? error) });
						}
					} while (this.rerun && !this.closed);
				}).finally(() => { this.pending = undefined; });
				return this.pending;
			}
			acceptView(row) {
				if (this.closed) return;
				this.generation++;
				if (this.pending) this.rerun = true;
				const current = this.getSnapshot();
				if (!current.view) return;
				const rows = current.view.namespaces;
				const namespaces = rows.some((item) => item.ns === row.ns)
					? rows.map((item) => item.ns === row.ns ? row : item) : [...rows, row];
				this.state.publish({ ...current, view: { ...current.view, namespaces } });
			}
			close() { this.closed = true; this.state.clear(); }
		}

		/** Public SettingsScope contract, backed by the existing authenticated RPC. */
		class SettingsScope {
			constructor(owner, spec, mirror, schema) {
				this.owner = owner;
				this.spec = spec;
				this.mirror = mirror;
				this.schema = schema;
				this.closed = false;
				this.tail = Promise.resolve();
				this.writeGeneration = 0;
				this.pendingRevision = undefined;
				this.state = observable({
					status: 'loading', mode: 'host', writable: false,
					value: undefined, base: undefined, user: undefined, revision: undefined
				});
				this.unsubscribe = mirror.subscribe(() => this.derive());
				this.derive();
			}
			getSnapshot() { return this.state.getSnapshot(); }
			subscribe(listener) { return this.state.subscribe(listener); }
			derive() {
				if (this.closed) return;
				const view = this.mirror.getSnapshot().view;
				if (!view) return;
				const row = view.namespaces.find((item) => item.ns === this.spec.namespace);
				const previous = this.getSnapshot();
				if (!row) {
					this.state.publish({ ...previous, status: 'unavailable', writable: view.writable });
					return;
				}
				let value;
				try {
					if (this.spec.decode) value = this.spec.decode(row.value);
					else if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)
						&& this.schema.validate(this.schema.rehydrate(row.schema), row.value) === undefined) value = row.value;
				} catch { /* An invalid schema/section must not replace the last accepted value. */ }
				this.state.publish({
					...previous, writable: view.writable, revision: row.revision, base: row.base, user: row.user,
					...(value === undefined ? {} : { status: 'ready', value })
				});
			}
			set(field, value) { return this.mutate([{ op: 'set', path: [field], value }]); }
			unset(field) { return this.mutate([{ op: 'unset', path: [field] }]); }
			mutate(operations, expectedRevision) {
				if (this.closed) return Promise.resolve();
				const owned = structuredClone(operations);
				const generation = ++this.writeGeneration;
				const task = this.tail.then(async () => {
					if (this.closed) return;
					await this.mirror.ensure();
					if (this.closed || !this.getSnapshot().writable) return;
					try {
						const response = await this.owner.remote.settings.mutate(
							this.spec.namespace, owned, expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision
						);
						if (this.closed) return;
						if (response.ok) {
							if (generation === this.writeGeneration) {
								this.pendingRevision = undefined;
								this.mirror.acceptView(response.value);
							} else this.pendingRevision = response.value.revision;
						} else if (generation === this.writeGeneration) {
							this.pendingRevision = undefined;
							await this.mirror.load();
						}
					} catch {
						if (!this.closed && generation === this.writeGeneration) {
							this.pendingRevision = undefined;
							await this.mirror.load();
						}
					}
				});
				this.tail = task.catch(() => {});
				return task;
			}
			async dispose() {
				this.closed = true;
				this.unsubscribe();
				this.state.clear();
				await this.tail;
			}
		}

		/** Cordis binds this.ctx to each consumer, preserving scope ownership. */
		class LanSettings extends Service {
			constructor(ctx, mirror) {
				super(ctx, 'settingsScope');
				this.owner = ctx;
				this.mirror = mirror;
				this.schema = ctx.settingsSchema;
			}
			describe() { return this.mirror; }
			bind(spec) {
				const scope = new SettingsScope(this.owner, spec, this.mirror, this.schema);
				this.ctx.effect(() => () => scope.dispose(), 'web-lan: settings consumer');
				void this.mirror.ensure();
				return scope;
			}
		}

		const provider = {
			name: 'web-lan-settings-provider',
			inject: ['remote', 'remote.settings', 'settingsSchema'],
			apply(ctx) {
				const mirror = new SettingsMirror(ctx.remote);
				ctx.effect(() => () => mirror.close(), 'web-lan: settings mirror');
				new LanSettings(ctx, mirror);
				ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { void mirror.load(); }));
				ctx.on('connection/reset', () => { void mirror.load(); });
				void mirror.ensure();
			}
		};

		async function apply(ctx) {
			if (globalThis.__DSH_WEB_LAN_SETTINGS__ !== true || ctx.remote.$host.isLoopback) return;
			const loader = ctx.loader;
			const candidates = [...loader.entries()].filter((entry) => entry.options.name === SETTINGS_PACKAGE && !entry.disabled);
			if (candidates.length !== 1) throw new Error('web-lan: expected one upstream settings provider; refusing ambiguous replacement');
			const source = candidates[0];
			await source.refresh();
			await source.fiber?.await();
			const previous = source.options.isolate?.settingsScope;
			if (previous !== undefined && previous !== ORIGINAL_SCOPE) return;
			const original = source.context.get('settingsScope');
			// A newer upstream may already support LAN settings. Leave it alone.
			if (original?.describe().getSnapshot().status !== 'unavailable') return;
			const containsSource = () => [...loader.entries()].includes(source);
			const reconfigure = async (isolation) => {
				const disabled = source.options.disabled;
				const previousIsolation = source.options.isolate ? { ...source.options.isolate } : null;
				// Stop/configure/start through public Loader APIs. A live service move
				// would leave its old disposer tied to the former isolation scope.
				try {
					await source.update({ disabled: true });
					await source.update({ isolate: isolation });
					await source.update({ disabled: disabled ?? null });
				} catch (error) {
					try {
						await source.update({ disabled: true });
						await source.update({ isolate: previousIsolation });
						await source.update({ disabled: disabled ?? null });
					} catch (rollbackError) {
						throw new AggregateError([error, rollbackError], 'web-lan: settings setup and rollback failed');
					}
					throw error;
				}
			};
			const restore = async () => {
				// A closing browser tree must not start new fibers during teardown.
				if (ctx.root.fiber.state === 5 || !containsSource() || source.options.isolate?.settingsScope !== ORIGINAL_SCOPE) return;
				const isolation = { ...source.options.isolate };
				delete isolation.settingsScope;
				await reconfigure(Object.keys(isolation).length ? isolation : null);
			};
			await ctx.effect(async () => {
				await reconfigure({ ...source.options.isolate, settingsScope: ORIGINAL_SCOPE });
				let fiber;
				try {
					fiber = ctx.plugin({ ...provider, apply(child) {
						if (!containsSource() || source.options.isolate?.settingsScope !== ORIGINAL_SCOPE) {
							child.logger.warn('web-lan: upstream settings entry changed; refresh the page to reconnect LAN settings');
							return;
						}
						provider.apply(child);
					} });
					await fiber.await();
				} catch (error) {
					await fiber?.dispose();
					await restore();
					throw error;
				}
				return async () => { await fiber.dispose(); await restore(); };
			}, 'web-lan: reversible settings provider');
		}

		return {
			name: 'web-lan-settings',
			inject: ['loader', 'remote', 'remote.settings'],
			apply
		};
	}
});
