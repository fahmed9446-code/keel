import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const readmeUrl = new URL('../README.md', import.meta.url);

test('README explains the product, supported tiers, and safety model', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  for (const phrase of [
    'Build fast. Stay on course.',
    'scanner gathers facts',
    'skill makes judgments',
    'Human approval',
    'No meaningful changes required',
    'Codex',
    'Claude Code',
    'Gemini CLI',
    'Uninstall',
    'Second run',
    'Apache-2.0',
  ]) assert.match(readme, new RegExp(phrase, 'i'));
});

test('README contains executable project-install and scanner commands', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.agents\/skills\//);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.claude\/skills\//);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.gemini\/skills\//);
  assert.match(readme, /node skills\/building-agent-harness\/scripts\/scan-repo\.mjs --root \/path\/to\/project/);
  assert.match(readme, /npm test/);
});

test('README has no private provenance or unresolved placeholders', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  assert.doesNotMatch(readme, /\/Users\/|Cue|cuelens|TODO|TBD|<founder|<owner/i);
});

test('all repository-relative README links resolve', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
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
  const entries = (await readdir(root)).filter((name) => name !== '.git').sort();
  assert.deepEqual(entries, ['.gitignore', 'LICENSE', 'README.md', 'package.json', 'skills', 'tests']);
});
