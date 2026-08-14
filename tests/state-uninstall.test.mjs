import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const skillUrl = new URL('../skills/building-agent-harness/SKILL.md', import.meta.url);
const contractUrl = new URL('../skills/building-agent-harness/references/installation-contract.md', import.meta.url);

test('skill loads the installation contract only after approval', async () => {
  const skill = await readFile(skillUrl, 'utf8');
  assert.match(skill, /After approval, read \[installation-contract\.md\]\(references\/installation-contract\.md\)/);
});

test('state example is deliberately tiny and contains only permitted fields', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const match = contract.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'installation contract must contain a JSON state example');
  const state = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(state), ['schemaVersion', 'keelVersion', 'installedChangeIds', 'declinedOrDeferredChangeIds', 'managedArtifacts']);
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.declinedOrDeferredChangeIds[0]), ['id', 'evidenceFingerprint', 'reason']);
  assert.deepEqual(Object.keys(state.managedArtifacts[0]), [
    'path',
    'createdByKeel',
    'changeIds',
    'preInstallHash',
    'preInstallGitOid',
    'postInstallHash',
  ]);
  assert.ok(state.managedArtifacts[0].changeIds.length > 0);
  assert.ok(state.managedArtifacts[0].changeIds.every((id) => state.installedChangeIds.includes(id)));
  assert.doesNotMatch(contract, /auditEvidence|prompt|transcript|tokenMetrics|sourceSnippet/);
});

test('every managed path has approved ownership without cross-package overlap', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /every managed artifact.*non-empty `changeIds`/is);
  assert.match(contract, /every.*`changeIds`.*approved.*installedChangeIds/is);
  assert.match(contract, /one managed-artifact record per repository-relative path/is);
  assert.match(contract, /different (?:approved )?(?:change )?packages.*same path.*refuse/is);
});

test('automatic edits to existing files require an exact clean tracked Git preimage', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /existing file.*Git worktree.*tracked.*clean/is);
  assert.match(contract, /stage-zero regular blob.*preInstallGitOid/is);
  assert.match(contract, /re-read.*blob.*exact.*current bytes/is);
  assert.match(contract, /dirty.*untracked.*non-Git.*unreconstructible.*refuse/is);
  assert.match(contract, /refusal.*must not create or update.*state/is);
});

test('contract requires exact approval and restrained second-run behavior', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /Approve exact change IDs/i);
  assert.match(contract, /separate approval immediately before/i);
  assert.match(contract, /same evidence fingerprint.*do not propose it again/is);
  assert.match(contract, /materially changed.*resurface/is);
  assert.match(contract, /No installation.*no state file/is);
  assert.match(
    contract,
    /Do not recommend tracking or committing `\.keel\/state\.json` solely because it is untracked/i,
  );
  assert.match(contract, /evaluate installed satisfaction through.*artifact.*changeIds/is);
  assert.match(contract, /missing.*ambiguous.*association.*do not.*re-propose.*overwrite/is);
});

test('uninstall cannot erase post-install user work', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /only.*Keel-created.*current hash equals.*post-install hash.*automatically/is);
  assert.match(contract, /do not delete/i);
  assert.match(contract, /reversal diff/i);
  assert.match(contract, /existing file changed by Keel.*never.*automatically/is);
  assert.match(contract, /retain.*state.*while.*unresolved/is);
  assert.match(contract, /remove.*installed change ID.*only after.*every artifact.*associated.*resolved/is);
  assert.match(contract, /Remove `\.keel\/state\.json` only after every managed artifact/is);
});

test('state v1 is read-only and migrates only through an exact provable approved package', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /schemaVersion`?\s*1.*recognize.*read-only/is);
  assert.match(contract, /separate.*exact.*migration.*change (?:ID|package).*approval/is);
  assert.match(contract, /prove.*artifact.*change ID.*pre-install Git blob/is);
  assert.match(contract, /ambiguous.*leave.*v1 state.*byte-for-byte untouched/is);
});

test('v1 migration treats the existing state file as a gated existing-file edit', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const migration = contract.match(/## State v1 compatibility and migration\n([\s\S]*?)\n## Second run/);
  assert.ok(migration, 'migration section must exist');
  assert.match(migration[1], /`\.keel\/state\.json`.*pass.*existing-file preimage gate/is);
  assert.match(migration[1], /state file.*dirty.*untracked.*refuse.*migration/is);
  assert.match(migration[1], /reviewable.*preimage.*established/is);
  assert.doesNotMatch(migration[1], /compare-and-swap|CAS exception/i);
});

test('v1 migration requires artifact-specific ownership provenance', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  const migration = contract.match(/## State v1 compatibility and migration\n([\s\S]*?)\n## Second run/);
  assert.ok(migration, 'migration section must exist');
  assert.match(migration[1], /artifact-specific.*independently verifiable.*path.*change-ID association/is);
  assert.match(migration[1], /approved install record.*path.*hash/is);
  assert.doesNotMatch(migration[1], /single installed change ID.*unambiguous/i);
  assert.match(migration[1], /cardinality.*not provenance/i);
});
