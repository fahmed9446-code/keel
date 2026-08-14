import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const readmeUrl = new URL('../README.md', import.meta.url);
const installationContractUrl = new URL(
  '../skills/building-agent-harness/references/installation-contract.md',
  import.meta.url,
);

async function loadReadme() {
  return readFile(readmeUrl, 'utf8');
}

test('README follows the beginner-first progressive heading order', async () => {
  const readme = await loadReadme();
  const headings = [
    '## Who Keel is for',
    '## What Keel can help with',
    '## The simple idea',
    '## Before Keel / After Keel',
    '## What Keel does not assume',
    '## How Keel works',
    '## Supported agents',
    '## Quick start',
    '## Technical architecture',
    '## Optional scanner',
    '## Approval, state, reruns, and uninstall',
    '## Development',
    '## Privacy',
    '## License',
  ];
  let cursor = -1;
  for (const heading of headings) {
    const next = readme.indexOf(heading);
    assert.ok(next > cursor, `${heading} must appear in the required order`);
    cursor = next;
  }
});

test('upper README answers the beginner comprehension contract before technical detail', async () => {
  const readme = await loadReadme();
  const upper = readme.slice(0, readme.indexOf('## Technical architecture'));
  for (const pattern of [
    /helps AI-built codebases stay fast, understandable, and on course as they grow/i,
    /solo founders/i,
    /vibe coders/i,
    /indie hackers/i,
    /product and design builders/i,
    /heavy coding-agent users/i,
    /Already have a clean setup\? That's fine\./,
    /No meaningful changes required/,
    /audit is read-only/i,
    /approve all, some, or none/i,
    /Codex/i,
    /Claude Code/i,
    /Gemini CLI/i,
  ]) assert.match(upper, pattern);
  assert.doesNotMatch(upper, /schema|classifier|fingerprint|Git OID/i);
});

test('README describes benefits as possibilities without guarantees or numeric promises', async () => {
  const readme = await loadReadme();
  for (const pattern of [
    /less wasted AI context/i,
    /potentially lower unnecessary token use/i,
    /less repeated explanation/i,
    /reduced drift/i,
    /easier long-task recovery/i,
    /clearer authority/i,
    /conditional independent review/i,
    /safer dangerous operations/i,
    /less unnecessary process/i,
    /better maintainability/i,
  ]) assert.match(readme, pattern);
  assert.doesNotMatch(readme, /\b\d+(?:\.\d+)?%\b/);
  assert.doesNotMatch(readme, /\bguarantee(?:d|s)?\b|\bensures?\b|\bprevent(?:s|ed)? (?:all )?bugs\b/i);
});

test('README preserves accurate support tiers and their limitations', async () => {
  const readme = await loadReadme();
  assert.match(readme, /methodology is shared[^.]*native mechanics differ/i);
  assert.match(readme, /Codex[^\n]*runtime-verified[^\n]*`codex-cli 0\.133\.0`/i);
  assert.match(readme, /Claude Code[^\n]*documented[^\n]*not locally runtime-verified/i);
  assert.match(readme, /Gemini CLI[^\n]*documented[^\n]*not locally runtime-verified/i);
});

test('README contains canonical clone, complete-directory install, audit, and scanner commands', async () => {
  const readme = await loadReadme();
  assert.match(readme, /git clone https:\/\/github\.com\/fahmed9446-code\/keel\.git/);
  assert.match(readme, /\ncd keel\n/);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.agents\/skills\//);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.claude\/skills\//);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.gemini\/skills\//);
  assert.match(readme, /Use building-agent-harness to audit this repository/i);
  assert.match(readme, /node skills\/building-agent-harness\/scripts\/scan-repo\.mjs --root \/path\/to\/project/);
  assert.match(readme, /npm test/);
});

test('README keeps scanner schema 2 and state schema 2 claims consistent with public contracts', async () => {
  const [readme, contract, manifestText] = await Promise.all([
    loadReadme(),
    readFile(installationContractUrl, 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const stateMatch = contract.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(stateMatch, 'installation contract must contain a state example');
  const state = JSON.parse(stateMatch[1]);

  assert.equal(manifest.version, '1.0.1');
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.keelVersion, manifest.version);
  assert.match(readme, /scanner schema 2/i);
  assert.match(readme, /registry `2026-08-14\.2`/i);
  assert.match(readme, /Git index\/blob snapshot/i);
  assert.match(readme, /path-status-only live facts/i);
  assert.match(readme, /32 KiB/);
  assert.match(readme, /4 KiB/);
  assert.match(readme, /state schema 2/i);
  for (const field of ['changeIds', 'preInstallGitOid', 'evidenceFingerprint']) {
    assert.match(readme, new RegExp(`\\b${field}\\b`));
  }
  assert.match(readme, /schema 1[^.]*legacy[^.]*read-only/i);
  assert.doesNotMatch(readme, /scanner (?:enumerates|reads) (?:the )?(?:live|current) (?:directory|working[- ]copy) content/i);
});

test('README has no private provenance or unresolved placeholders', async () => {
  const readme = await loadReadme();
  assert.doesNotMatch(readme, /\/Users\/|Cue|cuelens|TODO|TBD|<founder|<owner/i);
});

test('all repository-relative README links resolve', async () => {
  const readme = await loadReadme();
  for (const match of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
    const path = target.split('#')[0];
    await access(new URL(path, readmeUrl));
  }
});

test('package remains dependency-free and top-level contents stay bounded', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.license, 'Apache-2.0');
  const entries = (await readdir(root))
    .filter((name) => !['.git', '.superpowers'].includes(name))
    .sort();
  assert.deepEqual(entries, ['.gitignore', 'LICENSE', 'README.md', 'package.json', 'skills', 'tests']);
});
