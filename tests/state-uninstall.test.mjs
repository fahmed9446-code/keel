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
  assert.deepEqual(Object.keys(state.declinedOrDeferredChangeIds[0]), ['id', 'evidenceFingerprint', 'reason']);
  assert.deepEqual(Object.keys(state.managedArtifacts[0]), ['path', 'createdByKeel', 'preInstallHash', 'postInstallHash']);
  assert.doesNotMatch(contract, /auditEvidence|prompt|transcript|tokenMetrics|sourceSnippet/);
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
});

test('uninstall cannot erase post-install user work', async () => {
  const contract = await readFile(contractUrl, 'utf8');
  assert.match(contract, /current hash equals.*post-install hash/is);
  assert.match(contract, /do not delete/i);
  assert.match(contract, /reversal diff/i);
  assert.match(contract, /Remove `\.keel\/state\.json` last/);
});
