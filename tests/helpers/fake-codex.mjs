#!/usr/bin/env node

import { appendFile, access, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const repository = valueAfter('-C');
const outputPath = valueAfter('--output-last-message');
const schemaPath = valueAfter('--output-schema');
const prompt = args.at(-1);
const rubricCheckIds = [
  'repository-evidence-inspected',
  'decision-selected',
  'proposal-boundary-checked',
  'rejections-recorded',
  'communication-populated',
];
const communicationFields = [
  'mainTakeaway', 'technicalEvidence', 'permanentContextCost', 'permanentBytes',
  'inducedReading', 'facts', 'authorityJudgment', 'rejectedRecommendationsSummary',
  'riskJustification', 'runtimeLimitations',
];
const communication = (values) => Object.fromEntries(
  communicationFields.map((field) => [field, values[field] ?? '']),
);

const outputs = {
  'clean-repository': {
    decision: 'no-change',
    proposedChangeIds: [],
    evidence: [
      { id: 'small-agent-guidance', detail: 'AGENTS.md contains one short instruction surface.' },
      { id: 'human-review', detail: 'AGENTS.md requires human review.' },
    ],
    deliberatelyRejectedRecommendations: ['unrelated-control-plane', 'unrelated-product-scope'],
    communication: communication({
      mainTakeaway: 'No meaningful changes required. The instruction architecture is intentionally small.',
      technicalEvidence: 'The permanent guidance is one short file with tests and human review.',
    }),
  },
  'bloated-permanent-context': {
    decision: 'changes-proposed',
    proposedChangeIds: ['context-remove-unconditional-history-read'],
    evidence: [
      { id: 'unconditional-history-read', detail: 'AGENTS.md always requires the old handbook.' },
      { id: 'duplicated-instruction', detail: 'The same testing guidance appears in both files.' },
    ],
    deliberatelyRejectedRecommendations: ['context-replace-handbook', 'context-add-mandatory-generic-doc'],
    communication: communication({ permanentContextCost: 'The unconditional historical read adds repeated context on every task.' }),
  },
  'mechanically-induced-reading': {
    decision: 'changes-proposed',
    proposedChangeIds: ['context-remove-unconditional-startup-read'],
    evidence: [
      { id: 'unconditional-startup-read', detail: 'AGENTS.md says to read startup.md before every task.' },
      { id: 'optional-ideas-reference', detail: 'ideas.md is explicitly optional and relevant-only.' },
    ],
    deliberatelyRejectedRecommendations: ['context-treat-optional-read-as-required', 'context-add-canonical-document'],
    communication: communication({
      permanentBytes: 'The permanent AGENTS.md surface is short.',
      inducedReading: 'startup.md is mechanically required; ideas.md is not.',
    }),
  },
  'conflicting-current-and-historical-authority': {
    decision: 'no-change',
    proposedChangeIds: [],
    evidence: [
      { id: 'superseded-history', detail: 'old-plan.md is explicitly labeled superseded history.' },
      { id: 'current-authority-unresolved', detail: 'No file establishes current architecture authority.' },
    ],
    deliberatelyRejectedRecommendations: ['authority-infer-from-filename', 'history-delete-conflicting-material'],
    communication: communication({
      facts: 'The current instructions mark old-plan.md as superseded.',
      authorityJudgment: 'Current architectural authority cannot be established with confidence.',
    }),
  },
  'solo-local-first-with-human-review': {
    decision: 'no-change',
    proposedChangeIds: [],
    evidence: [
      { id: 'single-maintainer', detail: 'AGENTS.md identifies one maintainer.' },
      { id: 'local-tests', detail: 'The documented workflow runs tests locally.' },
      { id: 'human-release-review', detail: 'The maintainer reviews before release.' },
    ],
    deliberatelyRejectedRecommendations: ['control-add-github-controls', 'review-add-ai-review', 'control-add-hosted-service'],
    communication: communication({ rejectedRecommendationsSummary: 'Hosted controls and AI review are not justified.' }),
  },
  'material-technical-review-gap': {
    decision: 'changes-proposed',
    proposedChangeIds: ['review-add-independent-check'],
    evidence: [
      { id: 'destructive-migration', detail: 'The fixture drops and rebuilds customer_records.' },
      { id: 'same-agent-certification', detail: 'The implementing agent certifies its own work.' },
      { id: 'no-independent-review', detail: 'No independent review step exists.' },
    ],
    deliberatelyRejectedRecommendations: ['review-build-platform', 'review-claim-unverified-isolation'],
    communication: communication({
      riskJustification: 'Destructive migration risk justifies one lightweight independent check.',
      runtimeLimitations: 'A fresh context reduces shared reasoning but is not a security boundary.',
    }),
  },
};

function identifyScenario(guidance) {
  if (guidance.includes('# Agent handbook')) return 'bloated-permanent-context';
  if (guidance.includes('Before every task')) return 'mechanically-induced-reading';
  if (guidance.includes('# Current instructions')) return 'conflicting-current-and-historical-authority';
  if (guidance.includes('one maintainer')) return 'solo-local-first-with-human-review';
  if (guidance.includes('destructive migrations')) return 'material-technical-review-gap';
  if (guidance.includes('Keep changes small')) return 'clean-repository';
  return undefined;
}

function leaksOracle(scenarioId) {
  return ['<scenario-contract>', 'expectedDecision', 'exactProposedChangeIds',
    'forbiddenProposedChangeIds', 'exactRejectedRecommendationIds', 'mustDo', 'mustNotDo',
    'communicationRequirements', scenarioId].some((text) => prompt.includes(text));
}

if (!repository || !outputPath || !schemaPath || !prompt) {
  process.exitCode = 2;
} else {
  const scenarioId = identifyScenario(await readFile(join(repository, 'AGENTS.md'), 'utf8'));
  const expected = outputs[scenarioId];
  if (!expected) {
    process.exitCode = 2;
  } else {
    const response = structuredClone({ ...expected, rubricCheckIds });
    const mode = process.env.KEEL_FAKE_CODEX_MODE;
    if (scenarioId === 'clean-repository' && mode === 'hang-first') {
      process.on('SIGTERM', () => {});
      await appendFile(process.env.KEEL_FAKE_CODEX_LOG, `${JSON.stringify({
        args: args.slice(0, -1), repository, pid: process.pid, promptProvided: true,
        promptLeaksOracle: leaksOracle(scenarioId),
      })}\n`);
      await new Promise(() => setInterval(() => {}, 60_000));
    }
    if (scenarioId === 'clean-repository' && mode === 'malformed-first') {
      await writeFile(outputPath, 'not json\n');
    } else {
      if (scenarioId === 'clean-repository' && mode === 'missing-rubric-first') response.rubricCheckIds.shift();
      if (scenarioId === 'clean-repository' && mode === 'too-many-first') {
        response.decision = 'changes-proposed';
        response.proposedChangeIds = ['unearned-change'];
      }
      if (scenarioId === 'clean-repository' && mode === 'duplicate-rejection-first') {
        response.deliberatelyRejectedRecommendations = [
          expected.deliberatelyRejectedRecommendations[0],
          expected.deliberatelyRejectedRecommendations[0],
        ];
      }
      if (scenarioId === 'solo-local-first-with-human-review' && mode === 'forbidden-solo-proposal') {
        response.proposedChangeIds = ['install-independent-ai-review'];
      }
      await writeFile(outputPath, `${JSON.stringify(response)}\n`);
    }

    let skillInstalled = true;
    let fixtureInstalled = true;
    let schemaValid = true;
    try { await access(join(repository, '.agents/skills/building-agent-harness/SKILL.md')); } catch { skillInstalled = false; }
    try { await access(join(repository, 'AGENTS.md')); } catch { fixtureInstalled = false; }
    try {
      const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
      schemaValid = schema.required.includes('decision')
        && schema.required.includes('rubricCheckIds')
        && schema.additionalProperties === false;
    } catch { schemaValid = false; }
    const repositoryIsClean = execFileSync(
      'git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' },
    ) === '';
    await appendFile(process.env.KEEL_FAKE_CODEX_LOG, `${JSON.stringify({
      args: args.slice(0, -1), repository, skillInstalled, fixtureInstalled,
      repositoryIsClean,
      promptProvided: prompt.startsWith('Use the installed building-agent-harness skill'),
      promptLeaksOracle: leaksOracle(scenarioId), schemaValid, outputPath,
      outputIsOutsideRepository: dirname(outputPath) === dirname(repository),
    })}\n`);
  }
}
