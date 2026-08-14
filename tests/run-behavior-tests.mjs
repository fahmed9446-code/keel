#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scenariosPath = join(projectRoot, 'tests/scenarios.json');
const fixturesRoot = join(projectRoot, 'tests/fixtures/behavior-scenarios');
const skillSource = join(projectRoot, 'skills/building-agent-harness');
const codexBinary = process.env.KEEL_BEHAVIOR_CODEX_BIN || 'codex';
const manifest = JSON.parse(await readFile(scenariosPath, 'utf8'));
const rubricCheckIds = [
  'repository-evidence-inspected',
  'decision-selected',
  'proposal-boundary-checked',
  'rejections-recorded',
  'communication-populated',
];
const communicationFields = [
  'mainTakeaway',
  'technicalEvidence',
  'permanentContextCost',
  'permanentBytes',
  'inducedReading',
  'facts',
  'authorityJudgment',
  'rejectedRecommendationsSummary',
  'riskJustification',
  'runtimeLimitations',
];
const unique = (values) => [...new Set(values)].sort();
const universalContract = {
  decisionValues: ['no-change', 'changes-proposed'],
  proposalIds: unique(manifest.scenarios.flatMap((scenario) => [
    ...scenario.allowedProposedChangeIds,
    ...scenario.forbiddenProposedChangeIds,
  ])),
  rejectedRecommendationIds: unique(
    manifest.scenarios.flatMap((scenario) => scenario.exactRejectedRecommendationIds),
  ),
  evidenceIds: unique(manifest.scenarios.flatMap((scenario) => scenario.requiredEvidenceIds)),
  rubricCheckIds,
  communicationFields,
};
const activeChildren = new Set();
const activeTemporaryRoots = new Set();
let shuttingDown = false;

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', finish);
      resolve(false);
    }, timeoutMs);
    child.once('exit', finish);
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 1_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 1_000);
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...activeChildren].map(terminateChild));
  await Promise.all(
    [...activeTemporaryRoots].map((path) => rm(path, { recursive: true, force: true })),
  );
  process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));

function isolatedGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'proposedChangeIds',
    'rubricCheckIds',
    'evidence',
    'deliberatelyRejectedRecommendations',
    'communication',
  ],
  properties: {
    decision: { enum: ['no-change', 'changes-proposed'] },
    proposedChangeIds: {
      type: 'array',
      items: { type: 'string' },
    },
    rubricCheckIds: {
      type: 'array',
      items: { type: 'string' },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'detail'],
        properties: {
          id: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    deliberatelyRejectedRecommendations: {
      type: 'array',
      items: { type: 'string' },
    },
    communication: {
      type: 'object',
      additionalProperties: false,
      required: communicationFields,
      properties: Object.fromEntries(
        communicationFields.map((field) => [field, { type: 'string' }]),
      ),
    },
  },
};

function promptFor() {
  return [
    'Use the installed building-agent-harness skill to audit this synthetic repository read-only.',
    'Inspect only repository evidence and make the smallest justified decision.',
    'Return only the JSON object required by the supplied output schema.',
    'Select IDs only from the universal response catalog below, based on evidence you actually find.',
    'Include every universal rubric check ID. These IDs describe response sections, not pass/fail claims.',
    'For communication fields that are irrelevant, return an empty string.',
    'Keep factual evidence separate from judgments and keep deliberately rejected recommendations visible.',
    '',
    '<universal-response-contract>',
    JSON.stringify(universalContract),
    '</universal-response-contract>',
  ].join('\n');
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await cp(join(source, entry.name), join(destination, entry.name), { recursive: true });
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: 'ignore' });
    activeChildren.add(child);
    let timedOut = false;
    let forceTimer;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        }, timeoutMs)
      : undefined;
    child.once('error', (error) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({ code, signal, timedOut });
    });
  });
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${field} must be a non-empty string array`);
  }
}

function requireExactUniqueSet(actual, expected, field) {
  if (new Set(actual).size !== actual.length) throw new Error(`${field} must be unique`);
  if (actual.length !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new Error(`${field} do not match the scenario contract`);
  }
}

function validateResponse(scenario, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('response must be a JSON object');
  }
  if (!['no-change', 'changes-proposed'].includes(response.decision)) {
    throw new Error('decision is invalid');
  }
  if (!Array.isArray(response.proposedChangeIds)) {
    throw new Error('proposedChangeIds must be an array');
  }
  if (response.proposedChangeIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error('proposedChangeIds must contain non-empty strings');
  }
  if (new Set(response.proposedChangeIds).size !== response.proposedChangeIds.length) {
    throw new Error('proposedChangeIds must be unique');
  }
  if (response.proposedChangeIds.length > scenario.maximumProposedChangePackages) {
    throw new Error(
      `proposed ${response.proposedChangeIds.length} packages; maximum is ${scenario.maximumProposedChangePackages}`,
    );
  }
  for (const id of response.proposedChangeIds) {
    if (scenario.forbiddenProposedChangeIds.includes(id)) {
      throw new Error(`proposed change ID is forbidden ${id}`);
    }
    if (!scenario.allowedProposedChangeIds.includes(id)) {
      throw new Error(`proposed change ID is not allowed ${id}`);
    }
  }
  requireExactUniqueSet(response.proposedChangeIds, scenario.exactProposedChangeIds, 'proposed change IDs');
  if (response.decision !== scenario.expectedDecision) {
    throw new Error(`decision must be ${scenario.expectedDecision}`);
  }
  if (response.decision === 'no-change' && response.proposedChangeIds.length !== 0) {
    throw new Error('no-change decision cannot propose packages');
  }
  if (response.decision === 'changes-proposed' && response.proposedChangeIds.length === 0) {
    throw new Error('changes-proposed decision requires a proposed change ID');
  }
  if (!Array.isArray(response.rubricCheckIds)) {
    throw new Error('rubricCheckIds must be an array');
  }
  requireExactUniqueSet(response.rubricCheckIds, rubricCheckIds, 'rubric check IDs');
  if (!Array.isArray(response.evidence) || response.evidence.length === 0) {
    throw new Error('evidence must be a non-empty array');
  }
  const evidenceIds = [];
  for (const item of response.evidence) {
    if (!item || typeof item.id !== 'string' || typeof item.detail !== 'string' || item.detail.trim() === '') {
      throw new Error('evidence entries require an ID and detail');
    }
    evidenceIds.push(item.id);
  }
  requireExactUniqueSet(evidenceIds, scenario.requiredEvidenceIds, 'evidence IDs');
  requireStringArray(
    response.deliberatelyRejectedRecommendations,
    'deliberatelyRejectedRecommendations',
  );
  const rejected = response.deliberatelyRejectedRecommendations;
  requireExactUniqueSet(
    rejected,
    scenario.exactRejectedRecommendationIds,
    'deliberately rejected recommendation IDs',
  );
  if (!response.communication || typeof response.communication !== 'object') {
    throw new Error('communication must be an object');
  }
  for (const field of scenario.requiredCommunicationFields) {
    if (typeof response.communication[field] !== 'string' || response.communication[field].trim() === '') {
      throw new Error(`communication field is required ${field}`);
    }
  }
  for (const [field, prefix] of Object.entries(scenario.communicationPrefixes)) {
    if (!response.communication[field].startsWith(prefix)) {
      throw new Error(`communication field must begin with required text ${field}`);
    }
  }
}

async function runScenario(scenario) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `keel-behavior-${scenario.id}-`));
  activeTemporaryRoots.add(temporaryRoot);
  const repository = join(temporaryRoot, 'repository');
  const schemaPath = join(temporaryRoot, 'output-schema.json');
  const outputPath = join(temporaryRoot, 'response.json');

  try {
    await copyDirectoryContents(join(fixturesRoot, scenario.id), repository);
    const gitEnvironment = isolatedGitEnvironment();
    const gitResult = await run('git', ['init', '--quiet', '--template='], {
      cwd: repository,
      env: gitEnvironment,
      timeoutMs: 10_000,
    });
    if (gitResult.code !== 0) {
      throw new Error('could not initialize temporary repository');
    }

    await copyDirectoryContents(
      skillSource,
      join(repository, '.agents/skills/building-agent-harness'),
    );
    for (const args of [
      ['add', '--all'],
      [
        '-c',
        'user.name=Keel Behavior Tests',
        '-c',
        'user.email=behavior-tests@invalid.example',
        'commit',
        '--quiet',
        '-m',
        'Synthetic behavior fixture',
      ],
    ]) {
      const gitSetup = await run('git', args, {
        cwd: repository,
        env: gitEnvironment,
        timeoutMs: 10_000,
      });
      if (gitSetup.code !== 0) throw new Error('could not prepare temporary repository');
    }
    await writeFile(schemaPath, `${JSON.stringify(outputSchema)}\n`);

    const result = await run(
      codexBinary,
      [
        '-a',
        'never',
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--sandbox',
        'read-only',
        '-C',
        repository,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        promptFor(),
      ],
      { cwd: repository, env: process.env, timeoutMs: 600_000 },
    );
    if (result.timedOut) throw new Error('codex timed out');
    if (result.code !== 0) {
      throw new Error(result.signal ? 'codex process was interrupted' : `codex exited ${result.code}`);
    }

    let response;
    try {
      response = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch {
      throw new Error('response is not valid JSON');
    }
    validateResponse(scenario, response);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    activeTemporaryRoots.delete(temporaryRoot);
  }
}

let passed = 0;

for (const scenario of manifest.scenarios) {
  try {
    await runScenario(scenario);
    passed += 1;
    console.log(`PASS ${scenario.id}`);
  } catch (error) {
    console.log(`FAIL ${scenario.id}: ${error.message}`);
  }
}

const allPassed = passed === manifest.scenarios.length;
console.log(`${allPassed ? 'PASS' : 'FAIL'} ${passed}/${manifest.scenarios.length} behavior scenarios`);
if (!allPassed) process.exitCode = 1;
