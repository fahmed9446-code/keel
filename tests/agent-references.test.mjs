import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const referenceRoot = new URL('../skills/building-agent-harness/references/', import.meta.url);
const names = ['codex.md', 'claude-code.md', 'gemini-cli.md'];
const headings = [
  'Detection',
  'Always-loaded instructions',
  'Scoped/lazy instructions',
  'Skills',
  'Task memory',
  'Filesystem/network/capability controls',
  'Independent-review options',
  'Native install locations',
  'Known limitations',
  'Installation validation',
  'Capability baseline',
];

test('agent references share a document shape without an adapter interface', async () => {
  for (const name of names) {
    const text = await readFile(new URL(name, referenceRoot), 'utf8');
    let cursor = -1;
    for (const heading of headings) {
      const next = text.indexOf(`## ${heading}`);
      assert.ok(next > cursor, `${name}: ${heading} missing or out of order`);
      cursor = next;
    }
    assert.match(text, /Verified documentation date: 2026-08-14/);
    assert.doesNotMatch(text, /detect\(\)|inspectSurfaces\(\)|measureContext\(\)|mapArtifacts\(\)|validateInstallation\(\)/);
  }
});

test('Codex is the runtime-verified V1 reference', async () => {
  const text = await readFile(new URL('codex.md', referenceRoot), 'utf8');
  assert.match(text, /Runtime-verified capability/);
  assert.match(text, /codex-cli 0\.133\.0/);
  assert.match(text, /\.agents\/skills\/building-agent-harness/);
  assert.match(text, /codex exec.*--ephemeral.*--sandbox read-only/s);
});

test('Claude Code and Gemini CLI do not claim local runtime verification', async () => {
  for (const name of ['claude-code.md', 'gemini-cli.md']) {
    const text = await readFile(new URL(name, referenceRoot), 'utf8');
    assert.match(text, /Capability documented but not locally verified/);
    assert.match(text, /runtime executable was not available locally/i);
    assert.doesNotMatch(text, /^Runtime-verified capability$/m);
  }
});

test('conditional review and control-plane modules remain lightweight lenses', async () => {
  const review = await readFile(new URL('review-method.md', referenceRoot), 'utf8');
  const control = await readFile(new URL('control-plane-method.md', referenceRoot), 'utf8');
  assert.match(review, /same AI reasoning context/i);
  assert.match(review, /Keel Merge Brief/);
  assert.match(review, /existing meaningful human review.*Don't build/is);
  assert.doesNotMatch(review, /review database|review scoring platform|persistent review archive/i);
  assert.match(control, /local-first/i);
  assert.match(control, /GitHub.*distribution.*not.*target repositories/is);
  assert.doesNotMatch(control, /hosted controls are always|must use GitHub/i);
});
