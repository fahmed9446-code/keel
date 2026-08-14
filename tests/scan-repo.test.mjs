import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test from 'node:test';

const scanner = new URL('../skills/building-agent-harness/scripts/scan-repo.mjs', import.meta.url).pathname;
const fixture = new URL('./fixtures/agent-surfaces', import.meta.url).pathname;

function runScanner(root, extra = []) {
  const result = spawnSync(process.execPath, [scanner, '--root', root, ...extra], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return { raw: result.stdout, value: JSON.parse(result.stdout) };
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else await writeFile(to, await readFile(from));
  }
}

async function snapshot(root) {
  const values = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else {
        const info = await stat(absolute);
        values.push([relative(root, absolute), info.size, await readFile(absolute, 'hex')]);
      }
    }
  }
  await walk(root);
  return values.sort((a, b) => a[0].localeCompare(b[0]));
}

test('reports versioned agent surfaces and mechanically induced reading', () => {
  const { value } = runScanner(fixture);
  assert.equal(value.schemaVersion, 1);
  assert.match(value.registryVersion, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.ok(value.agentSurfaces.some((item) => item.path === 'AGENTS.md' && item.agent === 'codex'));
  assert.ok(value.agentSurfaces.some((item) => item.path === 'CLAUDE.md' && item.agent === 'claude-code'));
  assert.ok(value.agentSurfaces.some((item) => item.path === 'GEMINI.md' && item.agent === 'gemini-cli'));
  assert.ok(value.inducedReading.references.some((item) => item.sourcePath === 'AGENTS.md' && item.target === 'docs/architecture.md' && item.syntax === 'markdown-link'));
  assert.ok(value.inducedReading.references.some((item) => item.target === 'docs/runbook.md' && item.syntax === 'literal-path'));
  assert.deepEqual(value.packageScripts, ['check', 'test']);
});

test('summarizes sensitive indicators without exposing paths or values by default', () => {
  const { raw, value } = runScanner(fixture);
  assert.equal(value.sensitiveIndicators.envFiles, 1);
  assert.equal(value.sensitiveIndicators.keyLikeFiles, 1);
  assert.equal(value.sensitiveIndicators.trackedSensitiveFiles, 0);
  assert.doesNotMatch(raw, /\.env|id_rsa|synthetic-sensitive-placeholder/);

  const detailed = runScanner(fixture, ['--include-sensitive-paths']).value;
  assert.deepEqual(detailed.sensitiveIndicators.paths, ['.env', 'id_rsa']);
});

test('enforces a deterministic 32 KiB default output ceiling with explicit truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-large-'));
  await writeFile(join(root, 'AGENTS.md'), '# Instructions\n');
  for (let index = 0; index < 900; index += 1) {
    const name = `document-${String(index).padStart(4, '0')}-${'x'.repeat(30)}.md`;
    await writeFile(join(root, name), `${index}\n`);
  }
  const first = runScanner(root);
  const second = runScanner(root);
  assert.ok(Buffer.byteLength(first.raw) <= 32 * 1024);
  assert.equal(first.value.truncation.truncated, true);
  assert.ok(first.value.truncation.sectionsTruncated.length > 0);
  assert.ok(first.value.truncation.totalMatchingItems > first.value.truncation.itemsReturned);
  assert.equal(first.raw, second.raw);
});

test('reports tracked and untracked sensitive counts without mutating the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-git-'));
  await copyTree(fixture, root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'docs', 'package.json'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fix synthetic harness'], { cwd: root });
  execFileSync('git', ['add', '.env'], { cwd: root });
  const before = await snapshot(root);
  const { value } = runScanner(root);
  const after = await snapshot(root);
  assert.equal(value.sensitiveIndicators.trackedSensitiveFiles, 1);
  assert.equal(value.sensitiveIndicators.untrackedSensitiveFiles, 1);
  assert.equal(value.history.commitKeywordCounts.fix, 1);
  assert.deepEqual(after, before);
});

test('rejects an invalid output budget', () => {
  const result = spawnSync(process.execPath, [scanner, '--root', fixture, '--max-output-bytes', '100'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least 4096 bytes/);
});

test('does not include the absolute repository path', () => {
  const { raw, value } = runScanner(fixture);
  assert.equal(value.repository.name, basename(fixture));
  assert.doesNotMatch(raw, new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('does not inherit Git metadata from a parent repository', () => {
  const { value } = runScanner(fixture);
  assert.equal(value.repository.gitAvailable, false);
  assert.equal(value.history.commitsInspected, 0);
});
