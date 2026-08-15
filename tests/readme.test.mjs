import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
const execFileAsync = promisify(execFile);
const readmeUrl = new URL('../README.md', import.meta.url);
const installationContractUrl = new URL(
  '../skills/building-agent-harness/references/installation-contract.md',
  import.meta.url,
);
const workflowUrl = new URL('../.github/workflows/deterministic-tests.yml', import.meta.url);

async function loadReadme() {
  return readFile(readmeUrl, 'utf8');
}

function assertRestrainedBenefitClaims(readme) {
  const startHeading = '## What Keel can help with';
  const endHeading = '## The simple idea';
  const start = readme.indexOf(startHeading);
  const end = readme.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `${startHeading} must exist`);
  assert.ok(end > start, `${endHeading} must follow ${startHeading}`);
  const benefits = readme.slice(start, end);

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
  ]) assert.match(benefits, pattern);

  const leadIn = benefits.slice(0, benefits.indexOf('\n- '));
  assert.match(leadIn, /\b(?:depending on|may|might|can|could|potential(?:ly)?)\b/i);
  assert.match(benefits, /\b(?:not promised outcomes?|does not promise|no guarantee)\b/i);

  const positiveSubject = '(?:Keel|it|the tool|these changes?)\\s+'
    + '(?!(?:(?:does|do|can|will|is|are|may|might)\\s+not|cannot|never)\\b)';
  for (const outcome of [
    '(?:guarantees?|ensures?)\\b',
    '[^.!?\\n]{0,100}\\b(?:faster|quicker)\\b',
    '[^.!?\\n]{0,100}\\b(?:correct(?:ness)?|bug-free)\\b',
    '[^.!?\\n]{0,100}\\b(?:prevents?|eliminates?)\\b[^.!?\\n]{0,40}\\bbugs?\\b',
    '[^.!?\\n]{0,100}\\b(?:completely safe|guaranteed safety|safety guaranteed)\\b',
  ]) {
    assert.doesNotMatch(benefits, new RegExp(`\\b${positiveSubject}${outcome}`, 'i'));
  }

  // The brief prohibits percentage promises anywhere, not only in the benefits section.
  assert.doesNotMatch(readme, /\b\d+(?:\.\d+)?%\b/);
}

function benefitClaimFixture(claim, outsideSection = '') {
  return `# Keel

${outsideSection}

## What Keel can help with

Depending on the repository, a small, evidence-backed change may offer:

- Less wasted AI context and potentially lower unnecessary token use.
- Less repeated explanation and easier long-task recovery.
- Reduced drift and clearer authority.
- Conditional independent review.
- Safer dangerous operations.
- Less unnecessary process and better maintainability.

${claim}

These are potential benefits, not promised outcomes. Keel does not promise faster delivery, correctness, bug prevention, or complete safety.

## The simple idea
`;
}

test('README follows the beginner-first progressive heading order', async () => {
  const readme = await loadReadme();
  const headings = [
    '## Who Keel is for',
    '## What Keel can help with',
    '## The simple idea',
    '## How Keel differs from a linter',
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
  assertRestrainedBenefitClaims(readme);
});

test('benefit claim audit allows explicit negation and unrelated ensure wording', () => {
  const readme = benefitClaimFixture(
    [
      'Keel does not guarantee correctness.',
      'Keel cannot ensure correct code.',
      'Keel does not prevent bugs.',
      'Keel does not make delivery faster.',
      'Keel does not make dangerous operations completely safe.',
    ].join(' '),
    'Before installation, ensure Node.js is available.',
  );

  assert.doesNotThrow(() => assertRestrainedBenefitClaims(readme));
});

test('benefit claim audit rejects prohibited positive outcome claims', () => {
  for (const claim of [
    'Keel guarantees better results.',
    'Keel makes delivery faster.',
    'Keel produces correct code.',
    'Keel prevents bugs.',
    'Keel makes dangerous operations completely safe.',
  ]) {
    assert.throws(
      () => assertRestrainedBenefitClaims(benefitClaimFixture(claim)),
      assert.AssertionError,
      claim,
    );
  }
});

test('benefit claim audit allows raw measured repository facts', () => {
  const readme = benefitClaimFixture(
    'Always-loaded instruction surface: 14.2 KB across 4 files → 3.1 KB across 1 file.',
  );
  assert.doesNotThrow(() => assertRestrainedBenefitClaims(readme));
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
  assert.match(readme, /individual[^.]*install Keel once[^.]*user/i);
  assert.match(readme, /\$HOME\/\.agents\/skills/);
  assert.match(readme, /project-level[^.]*multiple contributors|multiple contributors[^.]*project-level/is);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.agents\/skills\//);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.claude\/skills\//);
  assert.match(readme, /cp -R skills\/building-agent-harness \/path\/to\/project\/\.gemini\/skills\//);
  assert.match(readme, /Use building-agent-harness to audit this repository/i);
  assert.match(readme, /node skills\/building-agent-harness\/scripts\/scan-repo\.mjs --root \/path\/to\/project/);
  assert.match(readme, /npm test/);
});

test('README distinguishes adaptive judgment from linting and bounds measured effects', async () => {
  const readme = await loadReadme();
  const linterSection = readme.slice(
    readme.indexOf('## How Keel differs from a linter'),
    readme.indexOf('## Before Keel / After Keel'),
  );
  assert.match(linterSection, /Linters are useful/i);
  assert.match(linterSection, /different layer/i);
  assert.match(linterSection, /No meaningful changes required/);
  assert.doesNotMatch(linterSection, /better than|superior|competitor/i);

  assert.match(readme, /Measured repository effects/i);
  assert.match(readme, /deterministic fact/i);
  assert.match(readme, /semantic judgment/i);
  assert.match(readme, /not[^.]*token[^.]*cost[^.]*speed|does not[^.]*token[^.]*cost[^.]*performance/is);
  assert.match(
    readme,
    /Example — illustrative values[\s\S]*Current measured fact:[\s\S]*Measured before → after[\s\S]*approved and validated cleanup/i,
  );
});

test('README describes the durable behavior runner without remediation history', async () => {
  const readme = await loadReadme();
  const development = readme.slice(readme.indexOf('## Development'), readme.indexOf('## Privacy'));
  assert.match(development, /`npm test`[^.]*deterministic[^.]*offline/i);
  assert.match(development, /`npm run test:behavior`[^.]*opt-in[^.]*live/i);
  assert.match(development, /required[^.]*forbidden[^.]*outcomes/i);
  assert.match(development, /bounded semantic diagnostics/i);
  assert.match(development, /not a model benchmark/i);
  assert.match(development, /Keel's public repository[^.]*GitHub[^.]*deterministic/i);
  assert.doesNotMatch(development, /alias|breaker|diagnostic cycle|historical live-run/i);
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

  assert.equal(manifest.version, '1.0.2');
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.keelVersion, manifest.version);
  assert.match(readme, /scanner schema 2/i);
  assert.match(readme, /registry `2026-08-14\.2`/i);
  assert.match(readme, /Git index\/blob snapshot/i);
  assert.match(readme, /path-status-only live facts/i);
  assert.match(readme, /32 KiB/);
  assert.match(readme, /4 KiB/);
  assert.match(readme, /--max-output-bytes[^.]*raise[^.]*32 KiB default/is);
  assert.match(readme, /state schema 2/i);
  for (const field of ['changeIds', 'preInstallGitOid', 'evidenceFingerprint']) {
    assert.match(readme, new RegExp(`\\b${field}\\b`));
  }
  assert.match(readme, /install.*state.*uninstall.*containment.*symbolic-link ancestor/is);
  assert.match(readme, /validation.*state persistence.*fails.*exact attempted postimage.*manual recovery/is);
  assert.match(readme, /schema 1[^.]*legacy[^.]*read-only/i);
  assert.doesNotMatch(readme, /scanner (?:enumerates|reads) (?:the )?(?:live|current) (?:directory|working[- ]copy) content/i);
});

test('README has no private provenance or unresolved placeholders', async () => {
  const readme = await loadReadme();
  assert.doesNotMatch(readme, /\/Users\/|TODO|TBD|<founder|<owner/i);
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
  const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: root });
  const entries = [...new Set(stdout.trim().split('\n').map((path) => path.split('/')[0]))].sort();
  assert.deepEqual(entries, ['.github', '.gitignore', 'LICENSE', 'README.md', 'package.json', 'skills', 'tests']);
});

test('single GitHub workflow runs only the deterministic suite with read-only permissions', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const workflowFiles = await readdir(new URL('../.github/workflows/', import.meta.url));
  assert.deepEqual(workflowFiles, ['deterministic-tests.yml']);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /uses: actions\/checkout@v7/);
  assert.match(workflow, /uses: actions\/setup-node@v7/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /run: npm test/);
  assert.doesNotMatch(workflow, /test:behavior|secret|permissions:[\s\S]*write|schedule:|matrix:|upload-artifact/i);
});
