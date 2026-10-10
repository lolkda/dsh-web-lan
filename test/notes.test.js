import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../.agents/notes/', import.meta.url));
const lifecycles = ['proposed', 'implemented', 'rejected', 'archived'];
const classes = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'];
const entries = readdirSync(root, { recursive: true, withFileTypes: true });
const notes = entries.filter(entry => entry.isFile());
test('note paths use the supported lifecycle and class tree', () => {
  assert.ok(notes.length);
  for (const entry of entries) {
    assert.ok(!entry.isSymbolicLink());
    const parts = relative(root, join(entry.parentPath, entry.name)).split(/[\\/]/);
    assert.ok(lifecycles.includes(parts[0]));
    if (parts.length > 1) assert.ok(classes.includes(parts[1]));
    if (entry.isFile()) {
      assert.equal(parts.length, 3);
      assert.match(entry.name, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/);
    }
  }
});
for (const entry of notes) {
  const path = join(entry.parentPath, entry.name);
  const lifecycle = relative(root, path).split(/[\\/]/)[0];
  test(`note format and links: ${relative(root, path)}`, () => {
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^# Agent Note: .+\n\nStatus: /);
    if (lifecycle === 'rejected') assert.match(text.split('\n')[2], /^Status: rejected — .+/);
    else assert.equal(text.split('\n')[2], `Status: ${lifecycle}`);
    const sections = ['Problem', 'Alternatives considered', ...(lifecycle === 'implemented' ? ['Decision', 'Consequences'] : ['Proposal', 'Acceptance criteria', 'Risks'])];
    for (const section of sections) assert.ok(text.includes(`\n## ${section}\n`), section);
    if (lifecycle === 'implemented') assert.doesNotMatch(text, /^## (?:Proposal|Plan|Migration plan|Acceptance criteria|提案|计划|迁移计划|验收标准)\s*$/m);
    for (const match of text.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(path), decodeURIComponent(target))), target);
    }
  });
}
