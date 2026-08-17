import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const referenceRoot = new URL('../skills/building-agent-harness/references/', import.meta.url);
const names = ['codex.md', 'claude-code.md', 'gemini-cli.md'];

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing ${heading} section`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

function requiresConcepts(text, concepts, mutation) {
  assert.ok(
    concepts.every((concept) => concept.test(text)),
    `${mutation}: missing one or more required concepts`,
  );
}

test('agent references share a document shape without an adapter interface', async () => {
  for (const name of names) {
    const text = await readFile(new URL(name, referenceRoot), 'utf8');
    const shape = name === 'codex.md'
      ? [
        'Detection',
        'Instruction loading',
        'Task memory',
        'Filesystem and network sandbox',
        'Shell command execution',
        'Approval policy',
        'Independent-review options',
        'Native install locations',
        'Known limitations',
        'Installation validation',
        'Capability baseline',
      ]
      : [
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
    let cursor = -1;
    for (const heading of shape) {
      const next = text.search(new RegExp(`^## ${heading.replaceAll(' ', '\\s+')}$`, 'm'));
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
  assert.match(text, /codex -a never exec.*--ephemeral.*--sandbox read-only/s);
  assert.doesNotMatch(text, /codex exec --ephemeral/);
});

test('agent references keep loading semantics owned by their native agent', async () => {
  const [codex, claude, gemini] = await Promise.all(
    names.map(async (name) => [name, await readFile(new URL(name, referenceRoot), 'utf8')]),
  );
  const references = Object.fromEntries([codex, claude, gemini]);
  const codexInstructions = section(references['codex.md'], 'Always-loaded instructions');
  const claudeInstructions = section(references['claude-code.md'], 'Always-loaded instructions');
  const geminiInstructions = section(references['gemini-cli.md'], 'Always-loaded instructions');

  const contracts = [
    {
      mutation: 'removing Codex root-to-CWD scope or per-directory override/fallback',
      text: codexInstructions,
      concepts: [/repository root/i, /current working directory/i, /AGENTS\.override\.md/, /AGENTS\.md/],
    },
    {
      mutation: 'presenting Codex’s documented 32 KiB default as live runtime state',
      text: codexInstructions,
      concepts: [/32 KiB/i, /documented default/i, /not.*effective runtime/i, /user-global/i],
    },
    {
      mutation: 'declaring Codex root-to-CWD semantics shared by Claude Code or Gemini CLI',
      text: codexInstructions,
      concepts: [/Codex-only/i, /not.*Claude Code/i, /not.*Gemini CLI/i],
    },
    {
      mutation: 'replacing Claude Code’s native instruction surface with Codex AGENTS files',
      text: claudeInstructions,
      concepts: [/CLAUDE\.md/],
      forbidden: /AGENTS(?:\.override)?\.md/,
    },
    {
      mutation: 'replacing Gemini CLI’s native instruction surface with Codex AGENTS files',
      text: geminiInstructions,
      concepts: [/GEMINI\.md/],
      forbidden: /AGENTS(?:\.override)?\.md/,
    },
  ];

  for (const { mutation, text, concepts, forbidden } of contracts) {
    requiresConcepts(text, concepts, mutation);
    if (forbidden) assert.doesNotMatch(text, forbidden, mutation);
  }
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
