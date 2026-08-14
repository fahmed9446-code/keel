import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const skillUrl = new URL('../skills/building-agent-harness/SKILL.md', import.meta.url);
const auditUrl = new URL('../skills/building-agent-harness/references/audit-method.md', import.meta.url);
const scenariosUrl = new URL('./scenarios.json', import.meta.url);

async function loadSkill() {
  return readFile(skillUrl, 'utf8');
}

test('skill metadata is discovery-focused and contains no scaffold placeholders', async () => {
  const skill = await loadSkill();
  assert.match(skill, /^---\nname: building-agent-harness\ndescription: Use when a repository relies heavily on AI coding agents and the user wants to audit or improve agent instructions, memory, context loading, review independence, or architectural drift across repeated coding sessions\.\n---/);
  assert.doesNotMatch(skill, /TODO|\[TODO/);
});

test('skill states the audit boundary and explicit anti-triggers', async () => {
  const skill = await loadSkill();
  assert.match(skill, /repository-level coding-agent harness/i);
  assert.match(skill, /write an AGENTS\.md/i);
  assert.match(skill, /review this code/i);
  assert.match(skill, /fix this bug/i);
  assert.match(skill, /optimize this one prompt/i);
});

test('skill makes read-only audit and no-change restraint binding', async () => {
  const skill = await loadSkill();
  assert.match(skill, /audit is read-only/i);
  assert.match(skill, /No meaningful changes required/);
  assert.match(skill, /five top-level proposed change packages/i);
  assert.match(skill, /exact change IDs/i);
});

test('skill fixes the user-facing report order', async () => {
  const skill = await loadSkill();
  const headings = [
    'Main takeaway',
    'Before → after',
    'What Keel recommends changing',
    'What will remain unchanged',
    'Findings',
    'Recommendations Keel deliberately rejected',
    'Review-independence / control-plane assessment',
    'Limitations and technical evidence',
  ];
  let cursor = -1;
  for (const heading of headings) {
    const next = skill.indexOf(heading);
    assert.ok(next > cursor, `${heading} must appear in report order`);
    cursor = next;
  }
});

test('scenario suite is capped at six pass-fail contracts', async () => {
  const scenarios = JSON.parse(await readFile(scenariosUrl, 'utf8'));
  assert.equal(scenarios.benchmark, false);
  assert.equal(scenarios.scenarios.length, 6);
  for (const scenario of scenarios.scenarios) {
    assert.ok(Array.isArray(scenario.mustDo) && scenario.mustDo.length > 0);
    assert.ok(Array.isArray(scenario.mustNotDo) && scenario.mustNotDo.length > 0);
    assert.ok(Number.isInteger(scenario.maximumProposedChangePackages));
    assert.ok(scenario.maximumProposedChangePackages <= 5);
    assert.ok(Array.isArray(scenario.communicationRequirements));
    assert.ok(Array.isArray(scenario.requirementSources));
  }
});

test('audit method documents the optional scanner safety boundary', async () => {
  const audit = await readFile(auditUrl, 'utf8');
  assert.match(audit, /node scripts\/scan-repo\.mjs --root/);
  assert.match(audit, /lexical and syntactic classification only/i);
  assert.match(audit, /32 KiB/);
  assert.match(audit, /--include-sensitive-paths/);
  assert.match(audit, /registryVersion/);
});
