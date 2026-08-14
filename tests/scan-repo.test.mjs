import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test from 'node:test';

const scanner = new URL('../skills/building-agent-harness/scripts/scan-repo.mjs', import.meta.url).pathname;
const fixture = new URL('./fixtures/agent-surfaces', import.meta.url).pathname;

function runScanner(root, extra = [], environment = {}) {
  const result = spawnSync(process.execPath, [scanner, '--root', root, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
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

function initializeRepository(root) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
}

async function snapshotFixtureRepository(prefix = 'keel-fixture-git-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await copyTree(fixture, root);
  initializeRepository(root);
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

test('never invokes live filesystem directory enumeration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-no-enumeration-root-'));
  const marker = join(await mkdtemp(join(tmpdir(), 'keel-no-enumeration-marker-')), 'enumerated');
  const preload = join(await mkdtemp(join(tmpdir(), 'keel-no-enumeration-preload-')), 'fail-readdir.cjs');
  await writeFile(join(root, 'AGENTS.md'), '[snapshot](docs/snapshot.md)\n');
  initializeRepository(root);
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: root });
  await writeFile(preload, `
const fs = require('node:fs');
const promises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
function failEnumeration() {
  fs.writeFileSync(process.env.KEEL_TEST_ENUMERATION_MARKER, 'enumerated\\n');
  throw new Error('live directory enumeration forbidden');
}
fs.readdir = failEnumeration;
fs.readdirSync = failEnumeration;
fs.opendir = failEnumeration;
fs.opendirSync = failEnumeration;
promises.readdir = failEnumeration;
promises.opendir = failEnumeration;
syncBuiltinESMExports();
`);

  const { value } = runScanner(root, [], {
    NODE_OPTIONS: `--require=${preload}`,
    KEEL_TEST_ENUMERATION_MARKER: marker,
  });

  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(value.evidenceProvenance.snapshot.kind, 'git-index-blob-snapshot');
});

test('reads staged index content while reporting unstaged working-copy content as a blind spot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-index-content-'));
  await writeFile(join(root, 'AGENTS.md'), '[committed](docs/committed.md)\n');
  initializeRepository(root);
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial'], { cwd: root });
  await writeFile(join(root, 'AGENTS.md'), '[staged](docs/staged.md)\n');
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: root });
  await writeFile(join(root, 'AGENTS.md'), '[unstaged](docs/unstaged.md)\n');

  const { value } = runScanner(root);

  assert.deepEqual(value.syntacticReferences.references, [
    { sourcePath: 'AGENTS.md', target: 'docs/staged.md', syntax: 'markdown-link' },
  ]);
  assert.equal(value.evidenceProvenance.snapshot.kind, 'git-index-blob-snapshot');
  assert.equal(value.evidenceProvenance.livePathStatus.dirtyPaths, 1);
  assert.equal(value.evidenceProvenance.livePathStatus.stagedPaths, 1);
  assert.equal(value.contentBlindSpots.dirtyFiles, 1);
});

test('counts untracked content as a blind spot without reading or naming it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-untracked-blind-'));
  await writeFile(join(root, 'tracked.txt'), 'tracked\n');
  initializeRepository(root);
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  await writeFile(join(root, 'AGENTS.md'), '[untracked](docs/untracked-secret.md)\n');

  const { raw, value } = runScanner(root);

  assert.deepEqual(value.agentSurfaces, []);
  assert.deepEqual(value.syntacticReferences.references, []);
  assert.equal(value.repository.untrackedFiles, 1);
  assert.equal(value.evidenceProvenance.livePathStatus.contentRead, false);
  assert.equal(value.contentBlindSpots.untrackedFiles, 1);
  assert.equal(value.contentBlindSpots.total, 1);
  assert.equal(value.nativeLiveInspectionRequired.required, true);
  assert.ok(value.nativeLiveInspectionRequired.reasons.includes('untracked-content-not-inspected'));
  assert.doesNotMatch(raw, /AGENTS\.md|untracked-secret/);
});

test('fails closed without enumerating or reading a non-Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-non-git-closed-'));
  await writeFile(join(root, 'AGENTS.md'), '[private](docs/private.md)\n');
  await writeFile(join(root, 'package.json'), '{"scripts":{"private-script":"echo private"}}\n');

  const { raw, value } = runScanner(root);

  assert.equal(value.repository.gitAvailable, false);
  assert.equal(value.files.total, null);
  assert.equal(value.files.totalBytes, null);
  assert.deepEqual(value.files.largest, []);
  assert.deepEqual(value.agentSurfaces, []);
  assert.deepEqual(value.syntacticReferences, { total: 0, references: [] });
  assert.deepEqual(value.packageScripts, []);
  assert.equal(value.evidenceProvenance.snapshot.available, false);
  assert.equal(value.evidenceProvenance.livePathStatus.available, false);
  assert.equal(value.sensitiveIndicators.envFiles, null);
  assert.equal(value.sensitiveIndicators.unknownSensitiveFiles, null);
  assert.equal(value.nativeLiveInspectionRequired.required, true);
  assert.ok(value.nativeLiveInspectionRequired.reasons.includes('git-snapshot-unavailable'));
  assert.ok(value.warnings.includes('Git snapshot unavailable; live filesystem content was not inspected.'));
  assert.doesNotMatch(raw, /AGENTS\.md|private\.md|private-script/);
});

test('reports schema 2 neutral scanner evidence', async () => {
  const root = await snapshotFixtureRepository();
  const { value } = runScanner(root);
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.registryVersion, '2026-08-14.2');
  assert.ok(value.agentSurfaces.some((item) => item.path === 'AGENTS.md' && item.agent === 'codex' && item.kind === 'instruction-file-candidate'));
  assert.ok(value.agentSurfaces.some((item) => item.path === 'CLAUDE.md' && item.agent === 'claude-code' && item.kind === 'instruction-file-candidate'));
  assert.ok(value.agentSurfaces.some((item) => item.path === 'GEMINI.md' && item.agent === 'gemini-cli' && item.kind === 'instruction-file-candidate'));
  assert.deepEqual([...new Set(value.agentSurfaces.map((item) => item.kind))], ['instruction-file-candidate']);
  assert.ok(value.syntacticReferences.references.some((item) => item.sourcePath === 'AGENTS.md' && item.target === 'docs/architecture.md' && item.syntax === 'markdown-link'));
  assert.ok(value.syntacticReferences.references.some((item) => item.target === 'docs/runbook.md' && item.syntax === 'literal-path'));
  assert.equal('inducedReading' in value, false);
  assert.deepEqual(value.packageScripts, ['check', 'test']);
});

test('emits neutral skill-directory candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-skill-directory-'));
  await mkdir(join(root, '.agents', 'skills'), { recursive: true });
  await writeFile(join(root, '.agents', 'skills', 'example.md'), 'snapshot candidate\n');
  initializeRepository(root);
  execFileSync('git', ['add', '.agents/skills/example.md'], { cwd: root });

  const { value } = runScanner(root);

  assert.ok(value.agentSurfaces.some((item) => item.path === '.agents/skills' && item.agent === 'codex' && item.kind === 'skill-directory-candidate'));
  assert.ok(value.agentSurfaces.some((item) => item.path === '.agents/skills' && item.agent === 'gemini-cli' && item.kind === 'skill-directory-candidate'));
});

test('summarizes sensitive indicators without exposing paths or values by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-sensitive-fixture-'));
  await copyTree(fixture, root);
  initializeRepository(root);
  execFileSync('git', ['add', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'docs', 'package.json'], { cwd: root });
  const { raw, value } = runScanner(root);
  assert.equal(value.sensitiveIndicators.envFiles, 1);
  assert.equal(value.sensitiveIndicators.keyLikeFiles, 1);
  assert.equal(value.sensitiveIndicators.trackedSensitiveFiles, 0);
  assert.doesNotMatch(raw, /\.env|id_rsa|synthetic-sensitive-placeholder/);

  const detailed = runScanner(root, ['--include-sensitive-paths']).value;
  assert.deepEqual(detailed.sensitiveIndicators.paths, ['.env', 'id_rsa']);
});

test('classifies every path component and redacts sensitive paths across evidence and metadata', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'keel-sensitive-parent-'));
  const root = join(parent, 'credential-repository');
  await mkdir(join(root, 'public', 'secrets'), { recursive: true });
  await mkdir(join(root, 'public', 'token-cache'), { recursive: true });
  await writeFile(join(root, 'public', 'secrets', 'AGENTS.md'), '[public](../../public.md)\n');
  await writeFile(join(root, 'public', 'token-cache', 'notes.md'), 'synthetic placeholder\n');
  await writeFile(join(root, 'public.md'), 'public\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial'], { cwd: root });

  const { raw, value } = runScanner(root);

  assert.equal(value.repository.name, '[redacted-sensitive-path]');
  assert.equal(value.sensitiveIndicators.credentialLikeFiles, 2);
  assert.doesNotMatch(raw, /credential-repository|secrets|token-cache/);
  assert.ok(value.files.largest.every((item) => !item.path.includes('[redacted')));
  assert.ok(value.agentSurfaces.every((item) => !item.path.includes('[redacted')));
  assert.ok(value.history.fileFrequency.every((item) => !item.path.includes('[redacted')));

  const detailed = runScanner(root, ['--include-sensitive-paths']).value;
  assert.deepEqual(detailed.sensitiveIndicators.paths, [
    'public/secrets/AGENTS.md',
    'public/token-cache/notes.md',
  ]);
});

test('resolves syntactic references from their source and accepts angle-bracket destinations with spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-references-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'AGENTS.md'), [
    '[guide](<guides/setup guide.md>)',
    '[root](../README.md)',
    '[escape](../../outside.md)',
  ].join('\n'));
  await writeFile(join(root, 'README.md'), 'root\n');
  initializeRepository(root);
  execFileSync('git', ['add', '.'], { cwd: root });

  const { value } = runScanner(root);
  const references = value.syntacticReferences.references;

  assert.ok(references.some((item) => item.sourcePath === 'docs/AGENTS.md' && item.target === 'docs/guides/setup guide.md'));
  assert.ok(references.some((item) => item.sourcePath === 'docs/AGENTS.md' && item.target === 'README.md'));
  assert.equal(references.some((item) => item.target.includes('outside.md')), false);
});

test('redacts sensitive syntactic-reference targets even when the target is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-reference-redaction-'));
  await writeFile(join(root, 'AGENTS.md'), '[private](secrets/credentials.md)\n[public](docs/guide.md)\n');
  initializeRepository(root);
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: root });

  const { raw, value } = runScanner(root);

  assert.deepEqual(value.syntacticReferences.references, [
    { sourcePath: 'AGENTS.md', target: 'docs/guide.md', syntax: 'markdown-link' },
  ]);
  assert.doesNotMatch(raw, /secrets|credentials/);
});

test('skips symbolic links without exposing link or target paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-links-'));
  const target = join(await mkdtemp(join(tmpdir(), 'keel-link-target-')), 'outside-instructions.md');
  await writeFile(target, '[outside](external-secret.md)\n');
  await symlink(target, join(root, 'AGENTS.md'));
  initializeRepository(root);
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: root });

  const { raw, value } = runScanner(root);

  assert.equal(value.files.skippedSymbolicLinks, 1);
  assert.deepEqual(value.agentSurfaces, []);
  assert.deepEqual(value.syntacticReferences.references, []);
  assert.ok(value.warnings.includes('Skipped 1 symbolic link; symbolic links are never followed.'));
  assert.doesNotMatch(raw, /AGENTS\.md|outside-instructions|external-secret/);
});

test('enforces a deterministic 32 KiB default output ceiling with explicit truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-large-'));
  await writeFile(join(root, 'AGENTS.md'), '# Instructions\n');
  for (let index = 0; index < 900; index += 1) {
    const name = `document-${String(index).padStart(4, '0')}-${'x'.repeat(30)}.md`;
    await writeFile(join(root, name), `${index}\n`);
  }
  initializeRepository(root);
  execFileSync('git', ['add', '.'], { cwd: root });
  const first = runScanner(root);
  const second = runScanner(root);
  assert.ok(Buffer.byteLength(first.raw) <= 32 * 1024);
  assert.equal(first.value.truncation.truncated, true);
  assert.ok(first.value.truncation.sectionsTruncated.length > 0);
  assert.ok(first.value.truncation.totalMatchingItems > first.value.truncation.itemsReturned);
  assert.equal(first.raw, second.raw);
});

test('populates truncation totals while enforcing the exact 4 KiB serialized ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-min-budget-'));
  for (let index = 0; index < 250; index += 1) {
    await writeFile(join(root, `evidence-${String(index).padStart(3, '0')}-${'x'.repeat(20)}.md`), 'x\n');
  }
  initializeRepository(root);
  execFileSync('git', ['add', '.'], { cwd: root });

  const { raw, value } = runScanner(root, ['--max-output-bytes', '4096']);

  assert.ok(Buffer.byteLength(raw) <= 4096, `report was ${Buffer.byteLength(raw)} bytes`);
  assert.equal(value.truncation.maxOutputBytes, 4096);
  assert.equal(value.truncation.totalMatchingItems, 250);
  assert.equal(value.truncation.itemsReturned, value.files.largest.length);
  assert.ok(value.truncation.totalMatchingItems > value.truncation.itemsReturned);
});

test('uses locale-independent code-unit ordering for report paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-order-'));
  await writeFile(join(root, 'Z.md'), 'same\n');
  await writeFile(join(root, 'a.md'), 'same\n');
  initializeRepository(root);
  execFileSync('git', ['add', '.'], { cwd: root });

  const { value } = runScanner(root);

  assert.deepEqual(value.files.largest.map((item) => item.path), ['Z.md', 'a.md']);
});

test('reports tracked, untracked, and ignored sensitive counts without mutating the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-git-'));
  await copyTree(fixture, root);
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, 'ignored', 'secret.pem'), 'synthetic ignored placeholder\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'docs', 'package.json'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fix synthetic harness'], { cwd: root });
  execFileSync('git', ['add', '.env'], { cwd: root });
  const before = await snapshot(root);
  const { value } = runScanner(root);
  const after = await snapshot(root);
  assert.equal(value.sensitiveIndicators.trackedSensitiveFiles, 1);
  assert.equal(value.sensitiveIndicators.untrackedSensitiveFiles, 1);
  assert.equal(value.sensitiveIndicators.ignoredSensitiveFiles, 1);
  assert.equal(value.sensitiveIndicators.unknownSensitiveFiles, 0);
  assert.equal(value.repository.untrackedFiles, 1);
  assert.equal(value.history.commitKeywordCounts.fix, 1);
  assert.deepEqual(after, before);
});

test('rejects an invalid output budget', () => {
  const result = spawnSync(process.execPath, [scanner, '--root', fixture, '--max-output-bytes', '100'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least 4096 bytes/);
});

test('returns stable path-safe CLI errors for unreadable roots', () => {
  const firstPath = join(tmpdir(), 'secret-token-missing-one');
  const secondPath = join(tmpdir(), 'credential-missing-two');
  const first = spawnSync(process.execPath, [scanner, '--root', firstPath], { encoding: 'utf8' });
  const second = spawnSync(process.execPath, [scanner, '--root', secondPath], { encoding: 'utf8' });

  assert.notEqual(first.status, 0);
  assert.notEqual(second.status, 0);
  assert.equal(first.stderr, 'scan-repo: --root must identify a readable directory\n');
  assert.equal(second.stderr, first.stderr);
});

test('does not include the absolute repository path', () => {
  const { raw, value } = runScanner(fixture);
  assert.equal(value.repository.name, basename(fixture));
  assert.doesNotMatch(raw, new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('does not inherit Git metadata from a parent repository', () => {
  const { value } = runScanner(fixture);
  assert.equal(value.repository.gitAvailable, false);
  assert.equal(value.repository.trackedFiles, null);
  assert.equal(value.repository.untrackedFiles, null);
  assert.equal(value.repository.ignoredFiles, null);
  assert.equal(value.sensitiveIndicators.trackedSensitiveFiles, null);
  assert.equal(value.sensitiveIndicators.untrackedSensitiveFiles, null);
  assert.equal(value.sensitiveIndicators.ignoredSensitiveFiles, null);
  assert.equal(value.sensitiveIndicators.unknownSensitiveFiles, null);
  assert.equal(value.history.commitsInspected, 0);
  assert.ok(value.warnings.includes('Git snapshot unavailable; live filesystem content was not inspected.'));
  assert.equal(value.nativeLiveInspectionRequired.required, true);
});

test('clears inherited Git repository state before collecting evidence', async () => {
  const foreign = await mkdtemp(join(tmpdir(), 'keel-foreign-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: foreign });
  await writeFile(join(foreign, 'foreign.txt'), 'foreign\n');
  execFileSync('git', ['add', 'foreign.txt'], { cwd: foreign });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'foreign fix'], { cwd: foreign });
  const root = await mkdtemp(join(tmpdir(), 'keel-clean-root-'));
  await writeFile(join(root, 'local.txt'), 'local\n');

  const { value } = runScanner(root, [], {
    GIT_DIR: join(foreign, '.git'),
    GIT_WORK_TREE: root,
    GIT_COMMON_DIR: join(foreign, '.git'),
  });

  assert.equal(value.repository.gitAvailable, false);
  assert.equal(value.history.commitsInspected, 0);
});

test('hardens every Git subprocess against config, hooks, fsmonitor, locking, prompts, lazy fetch, and network retrieval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-hardened-root-'));
  const bin = await mkdtemp(join(tmpdir(), 'keel-hardened-bin-'));
  const fakeGit = join(bin, 'git');
  await writeFile(fakeGit, `#!/usr/bin/env node
const args = process.argv.slice(2);
const requiredArgs = [
  '--no-optional-locks',
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'protocol.allow=never',
  'credential.interactive=never',
  'fetch.recurseSubmodules=false',
  'submodule.recurse=false',
  'maintenance.auto=false',
  'gc.auto=0',
];
const requiredEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_PROTOCOL_FROM_USER: '0',
};
if (requiredArgs.some((value) => !args.includes(value))) process.exit(91);
if (Object.entries(requiredEnvironment).some(([name, value]) => process.env[name] !== value)) process.exit(92);
if (process.env.GIT_CONFIG_COUNT || process.env.GIT_CONFIG_PARAMETERS || process.env.GIT_DIR || process.env.GIT_IMPLICIT_WORK_TREE || process.env.GIT_WORK_TREE) process.exit(93);
const rootIndex = args.indexOf('-C');
if (args.includes('rev-parse')) process.stdout.write(args[rootIndex + 1] + '\\n');
`);
  await chmod(fakeGit, 0o755);

  const { value } = runScanner(root, [], {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/untrusted/fsmonitor'",
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: '/untrusted/fsmonitor',
    GIT_DIR: '/untrusted/git-dir',
    GIT_IMPLICIT_WORK_TREE: '1',
    GIT_WORK_TREE: '/untrusted/work-tree',
  });

  assert.equal(value.repository.gitAvailable, true);
});

test('does not execute a repository-configured fsmonitor hook or mutate the worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-fsmonitor-root-'));
  const marker = join(await mkdtemp(join(tmpdir(), 'keel-fsmonitor-marker-')), 'executed');
  const monitor = join(root, 'hostile-fsmonitor');
  await writeFile(join(root, 'tracked.txt'), 'tracked\n');
  await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '\\n'\n`);
  await chmod(monitor, 0o755);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial'], { cwd: root });
  execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: root });
  const before = await snapshot(root);

  runScanner(root);

  const after = await snapshot(root);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.deepEqual(after, before);
});

test('clears inherited Git trace destinations so evidence collection cannot write files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-git-trace-root-'));
  await writeFile(join(root, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial'], { cwd: root });
  const traceVariables = [
    'GIT_TRACE',
    'GIT_TRACE_PERFORMANCE',
    'GIT_TRACE2',
    'GIT_TRACE2_EVENT',
    'GIT_TRACE2_PERF',
  ];
  const environment = {};
  const markers = traceVariables.map((name) => join(root, `trace-${name.toLowerCase().replaceAll('_', '-')}.log`));
  for (let index = 0; index < traceVariables.length; index += 1) environment[traceVariables[index]] = markers[index];

  runScanner(root, [], environment);

  for (const marker of markers) await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('bounds Git evidence collection time and degrades timeout to a path-free warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-timeout-root-'));
  const bin = await mkdtemp(join(tmpdir(), 'keel-timeout-bin-'));
  const fakeGit = join(bin, 'git');
  await writeFile(fakeGit, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n');
  await chmod(fakeGit, 0o755);

  const started = Date.now();
  const { raw, value } = runScanner(root, [], { PATH: `${bin}:${process.env.PATH}` });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3_000, `scanner took ${elapsed}ms`);
  assert.equal(value.repository.gitAvailable, false);
  assert.ok(value.warnings.includes('Git snapshot unavailable; live filesystem content was not inspected.'));
  assert.doesNotMatch(raw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('degrades a failed Git fact query to explicit incomplete evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-partial-git-root-'));
  await writeFile(join(root, '.env'), 'synthetic placeholder\n');
  const bin = await mkdtemp(join(tmpdir(), 'keel-partial-git-bin-'));
  const fakeGit = join(bin, 'git');
  await writeFile(fakeGit, `#!/usr/bin/env node
const args = process.argv.slice(2);
const rootIndex = args.indexOf('-C');
if (args.includes('rev-parse')) process.stdout.write(args[rootIndex + 1] + '\\n');
else if (args.includes('--stage')) process.exit(1);
`);
  await chmod(fakeGit, 0o755);

  const { raw, value } = runScanner(root, [], { PATH: `${bin}:${process.env.PATH}` });

  assert.equal(value.repository.gitAvailable, true);
  assert.equal(value.repository.trackedFiles, null);
  assert.equal(value.evidenceProvenance.snapshot.available, false);
  assert.equal(value.sensitiveIndicators.unknownSensitiveFiles, 0);
  assert.ok(value.warnings.includes('Git index snapshot unavailable; tracked paths and content are incomplete.'));
  assert.doesNotMatch(raw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('degrades an invalid Git top-level response without exposing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-invalid-top-level-'));
  const bin = await mkdtemp(join(tmpdir(), 'keel-invalid-top-level-bin-'));
  const fakeGit = join(bin, 'git');
  await writeFile(fakeGit, '#!/usr/bin/env node\nprocess.stdout.write("/secret/credential-missing\\n");\n');
  await chmod(fakeGit, 0o755);

  const { raw, value } = runScanner(root, [], { PATH: `${bin}:${process.env.PATH}` });

  assert.equal(value.repository.gitAvailable, false);
  assert.ok(value.warnings.includes('Git snapshot unavailable; live filesystem content was not inspected.'));
  assert.doesNotMatch(raw, /secret|credential-missing/);
});

test('returns a stable path-free error if the repository root disappears during Git collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keel-root-mutation-secret-'));
  await mkdir(join(root, 'nested'));
  const bin = await mkdtemp(join(tmpdir(), 'keel-root-mutation-bin-'));
  const fakeGit = join(bin, 'git');
  await writeFile(fakeGit, `#!/usr/bin/env node
const { renameSync } = require('node:fs');
const args = process.argv.slice(2);
const rootIndex = args.indexOf('-C');
const root = args[rootIndex + 1];
if (args.includes('rev-parse')) {
  renameSync(root, root + '-moved');
  process.stdout.write(root + '\\n');
}
`);
  await chmod(fakeGit, 0o755);

  const result = spawnSync(process.execPath, [scanner, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, 'scan-repo: repository changed during scan\n');
});
