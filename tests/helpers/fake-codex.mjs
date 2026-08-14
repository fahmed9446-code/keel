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
const rubricKinds = [
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

const scenarioPresentation = {
  'clean-repository': {
    evidence: [
      { detail: 'AGENTS.md contains one short instruction surface.' },
      { detail: 'AGENTS.md requires human review.' },
    ],
    communication: communication({
      mainTakeaway: 'No meaningful changes required. The instruction architecture is intentionally small.',
      technicalEvidence: 'The permanent guidance is one short file with tests and human review.',
    }),
  },
  'bloated-permanent-context': {
    evidence: [
      { detail: 'AGENTS.md always requires the old handbook.' },
      { detail: 'The same testing guidance appears in both files.' },
    ],
    communication: communication({ permanentContextCost: 'The unconditional historical read adds repeated context on every task.' }),
  },
  'mechanically-induced-reading': {
    evidence: [
      { detail: 'AGENTS.md says to read startup.md before every task.' },
      { detail: 'ideas.md is explicitly optional and relevant-only.' },
    ],
    communication: communication({
      permanentBytes: 'The permanent AGENTS.md surface is short.',
      inducedReading: 'startup.md is mechanically required; ideas.md is not.',
    }),
  },
  'conflicting-current-and-historical-authority': {
    evidence: [
      { detail: 'old-plan.md is explicitly labeled superseded history.' },
      { detail: 'No file establishes current architecture authority.' },
    ],
    communication: communication({
      facts: 'The current instructions mark old-plan.md as superseded.',
      authorityJudgment: 'Current architectural authority cannot be established with confidence.',
    }),
  },
  'solo-local-first-with-human-review': {
    evidence: [
      { detail: 'AGENTS.md identifies one maintainer.' },
      { detail: 'The documented workflow runs tests locally.' },
      { detail: 'The maintainer reviews before release.' },
    ],
    communication: communication({ rejectedRecommendationsSummary: 'Hosted controls and AI review are not justified.' }),
  },
  'material-technical-review-gap': {
    evidence: [
      { detail: 'The fixture drops and rebuilds customer_records.' },
      { detail: 'The implementing agent certifies its own work.' },
      { detail: 'No independent review step exists.' },
    ],
    communication: communication({
      riskJustification: 'Destructive migration risk justifies one lightweight independent check.',
      runtimeLimitations: 'A fresh context reduces shared reasoning but is not a security boundary.',
    }),
  },
};

const semanticOutputs = {
  'clean-repository': {
    proposalTypes: [],
    evidenceKinds: ['small-instruction-surface', 'human-review-present'],
    rejectionTypes: ['add-hosted-control', 'expand-outside-audit-scope'],
  },
  'bloated-permanent-context': {
    proposalTypes: ['reduce-permanent-context'],
    evidenceKinds: ['unconditional-history-read', 'duplicated-instruction'],
    rejectionTypes: ['replace-handbook', 'add-mandatory-generic-document'],
  },
  'mechanically-induced-reading': {
    proposalTypes: ['remove-unconditional-read'],
    evidenceKinds: ['unconditional-startup-read', 'optional-reference'],
    rejectionTypes: ['treat-optional-reference-as-required', 'add-canonical-document'],
  },
  'conflicting-current-and-historical-authority': {
    proposalTypes: ['clarify-current-authority'],
    evidenceKinds: ['superseded-history', 'current-authority-unclear'],
    rejectionTypes: ['infer-authority-from-filename', 'delete-history'],
  },
  'solo-local-first-with-human-review': {
    proposalTypes: [],
    evidenceKinds: ['single-maintainer', 'local-first-workflow', 'human-review-present'],
    rejectionTypes: ['add-hosted-control', 'add-ai-review', 'add-hosted-service'],
  },
  'material-technical-review-gap': {
    proposalTypes: ['add-lightweight-independent-review'],
    evidenceKinds: ['destructive-operation', 'same-context-certification', 'independent-review-absent'],
    rejectionTypes: ['build-review-platform', 'claim-unverified-isolation'],
  },
};

function semanticResponse(scenarioId, expected, idPrefix) {
  const semantics = semanticOutputs[scenarioId];
  return {
    decision: semantics.proposalTypes.length === 0 ? 'no-change' : 'changes-proposed',
    proposedChanges: semantics.proposalTypes.map((type, index) => ({
      id: `${idPrefix}-proposal-${index + 1}`,
      type,
    })),
    rubricChecks: rubricKinds.map((kind, index) => ({
      id: `${idPrefix}-rubric-${index + 1}`,
      kind,
    })),
    evidence: semantics.evidenceKinds.map((kind, index) => ({
      id: `${idPrefix}-evidence-${index + 1}`,
      kind,
      detail: expected.evidence[index].detail,
    })),
    deliberatelyRejectedRecommendations: semantics.rejectionTypes.map((type, index) => ({
      id: `${idPrefix}-rejection-${index + 1}`,
      type,
    })),
    communication: expected.communication,
  };
}

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
  return ['<scenario-contract>', 'expectedDecision', 'exactProposalTypes',
    'forbiddenProposalTypes', 'exactRejectionTypes', 'requiredEvidenceKinds', 'mustDo', 'mustNotDo',
    'communicationRequirements', scenarioId].some((text) => prompt.includes(text));
}

if (!repository || !outputPath || !schemaPath || !prompt) {
  process.exitCode = 2;
} else {
  const scenarioId = identifyScenario(await readFile(join(repository, 'AGENTS.md'), 'utf8'));
  const expected = scenarioPresentation[scenarioId];
  if (!expected) {
    process.exitCode = 2;
  } else {
    let response = semanticResponse(scenarioId, expected, `fixture-${scenarioId}`);
    const mode = process.env.KEEL_FAKE_CODEX_MODE;
    if (mode === 'alternate-trace-ids') {
      response = semanticResponse(scenarioId, expected, `alternate-${scenarioId}`);
    }
    if (mode === 'wrong-semantic-type') {
      response = semanticResponse(scenarioId, expected, `wrong-${scenarioId}`);
      if (scenarioId === 'solo-local-first-with-human-review') {
        response.proposedChanges = [{ id: 'wrong-solo-proposal', type: 'add-ai-review' }];
      }
    }
    if (scenarioId === 'clean-repository' && mode === 'extra-valid-evidence-first') {
      response.evidence.push({
        id: 'extra-valid-local-workflow',
        kind: 'local-first-workflow',
        detail: 'AGENTS.md directs contributors to run node --test before handoff.',
      });
    }
    if (scenarioId === 'clean-repository' && mode === 'missing-required-evidence-first') {
      response.evidence.shift();
    }
    if (scenarioId === 'clean-repository' && mode === 'unknown-evidence-first') {
      response.evidence.push({
        id: 'unknown-evidence',
        kind: 'fabricated-evidence-kind',
        detail: 'This semantic kind is outside the universal catalog.',
      });
    }
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
      if (scenarioId === 'clean-repository' && mode === 'missing-rubric-first') response.rubricChecks.shift();
      if (scenarioId === 'clean-repository' && mode === 'too-many-first') {
        response.decision = 'changes-proposed';
        response.proposedChanges = [{ id: 'unearned-change', type: 'add-hosted-control' }];
      }
      if (scenarioId === 'clean-repository' && mode === 'duplicate-rejection-first') {
        const first = response.deliberatelyRejectedRecommendations[0];
        response.deliberatelyRejectedRecommendations = [
          first,
          { ...first },
        ];
      }
      if (scenarioId === 'solo-local-first-with-human-review' && mode === 'forbidden-solo-proposal') {
        response.proposedChanges = [{ id: 'install-independent-ai-review', type: 'add-ai-review' }];
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
        && schema.required.includes('rubricChecks')
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
