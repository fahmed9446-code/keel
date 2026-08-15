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
const rubricKinds = [
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
  proposalTypes: unique(manifest.scenarios.flatMap((scenario) => [
    ...(scenario.outcomeContract.mustDo.anyProposalTypes ?? []),
    ...scenario.outcomeContract.mustNotDo.proposalTypes,
  ])),
  rubricKinds,
  communicationFields,
};
const activeChildren = new Map();
const activeTemporaryRoots = new Set();
const retainedTemporaryRoots = new Set();
const activeScenarioTasks = new Set();
let shuttingDown = false;

function requireRunning() {
  if (shuttingDown) throw new Error('shutdown in progress');
}

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

async function terminateChild(child, temporaryRoot) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  if (await waitForExit(child, 1_000)) return true;
  const forceUnconfirmed = process.env.KEEL_BEHAVIOR_TEST_FORCE_UNCONFIRMED_EXIT === '1';
  if (forceUnconfirmed && temporaryRoot) retainedTemporaryRoots.add(temporaryRoot);
  child.kill('SIGKILL');
  const confirmed = await waitForExit(child, 1_000);
  if ((!confirmed || forceUnconfirmed) && temporaryRoot) {
    retainedTemporaryRoots.add(temporaryRoot);
  }
  return confirmed && !forceUnconfirmed;
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (process.env.KEEL_BEHAVIOR_TEST_POST_SHUTDOWN_SPAWN_MARKER) {
    try {
      await run(
        process.execPath,
        [
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], "spawned")',
          process.env.KEEL_BEHAVIOR_TEST_POST_SHUTDOWN_SPAWN_MARKER,
        ],
        { timeoutMs: 1_000 },
      );
    } catch {}
  }
  const processed = new Set();
  let childExitUnconfirmed = false;
  while (true) {
    const pending = [...activeChildren.entries()].filter(([child]) => !processed.has(child));
    if (pending.length === 0) break;
    for (const [child] of pending) processed.add(child);
    const results = await Promise.all(
      pending.map(([child, { temporaryRoot }]) => terminateChild(child, temporaryRoot)),
    );
    if (results.some((confirmed) => confirmed === false)) childExitUnconfirmed = true;
  }

  await Promise.race([
    Promise.allSettled([...activeScenarioTasks]),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);

  let cleanupFailed = false;
  for (const path of activeTemporaryRoots) {
    if (retainedTemporaryRoots.has(path)) continue;
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (childExitUnconfirmed) {
    console.log('FAIL cleanup: child exit unconfirmed; temporary data retained');
    process.exit(1);
  }
  if (cleanupFailed) {
    console.log('FAIL cleanup: temporary data removal failed');
    process.exit(1);
  }
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
    'proposedChanges',
    'rubricChecks',
    'evidence',
    'deliberatelyRejectedRecommendations',
    'communication',
  ],
  properties: {
    decision: { enum: ['no-change', 'changes-proposed'] },
    proposedChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type'],
        properties: {
          id: { type: 'string' },
          type: { enum: universalContract.proposalTypes },
        },
      },
    },
    rubricChecks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind'],
        properties: { id: { type: 'string' }, kind: { enum: rubricKinds } },
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'detail'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', minLength: 1 },
          detail: { type: 'string' },
        },
      },
    },
    deliberatelyRejectedRecommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', minLength: 1 },
        },
      },
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
    'Create concise unique non-empty IDs for traceability; IDs are not semantic verdicts.',
    'Select proposal types only from the universal catalog below, based on evidence you actually find.',
    'Use concise semantic labels for evidence and deliberately rejected recommendations; equivalent wording is acceptable.',
    'Include one rubric check for every universal rubric kind. Rubric checks describe response sections, not pass/fail claims.',
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
    requireRunning();
    const { timeoutMs, temporaryRoot, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: 'ignore' });
    activeChildren.set(child, { temporaryRoot });
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

function requireExactUniqueSet(actual, expected, field) {
  if (new Set(actual).size !== actual.length) throw new Error(`${field} must be unique`);
  if (actual.length !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new Error(`${field} do not match the scenario contract`);
  }
}

function requireAnyProposalType(actual, requiredAny) {
  if (new Set(actual).size !== actual.length) throw new Error('proposal types must be unique');
  if (!requiredAny.some((type) => actual.includes(type))) {
    throw new Error('proposal types do not match the scenario contract');
  }
}

function requireTraceEntries(value, field, semanticField) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const ids = [];
  const semantics = [];
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`${field} IDs must be non-empty strings`);
    }
    if (typeof item[semanticField] !== 'string' || item[semanticField].trim() === '') {
      throw new Error(`${field} ${semanticField}s must be non-empty strings`);
    }
    ids.push(item.id);
    semantics.push(item[semanticField]);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${field} IDs must be unique`);
  return semantics;
}

function validateResponse(scenario, response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('response must be a JSON object');
  }
  if (!['no-change', 'changes-proposed'].includes(response.decision)) {
    throw new Error('decision is invalid');
  }
  const { mustDo, mustNotDo, maximumProposedChangePackages } = scenario.outcomeContract;
  const proposalTypes = requireTraceEntries(response.proposedChanges, 'proposal', 'type');
  if (response.proposedChanges.length > maximumProposedChangePackages) {
    throw new Error(
      `proposed ${response.proposedChanges.length} packages; maximum is ${maximumProposedChangePackages}`,
    );
  }
  for (const type of proposalTypes) {
    if (mustNotDo.proposalTypes.includes(type)) {
      throw new Error(`proposal type is forbidden ${type}`);
    }
  }
  if (mustDo.anyProposalTypes) {
    requireAnyProposalType(proposalTypes, mustDo.anyProposalTypes);
  }
  if (response.decision !== mustDo.decision) {
    throw new Error(`decision must be ${mustDo.decision}`);
  }
  if (response.decision === 'no-change' && response.proposedChanges.length !== 0) {
    throw new Error('no-change decision cannot propose packages');
  }
  if (response.decision === 'changes-proposed' && response.proposedChanges.length === 0) {
    throw new Error('changes-proposed decision requires a proposed change ID');
  }
  const responseRubricKinds = requireTraceEntries(response.rubricChecks, 'rubric check', 'kind');
  requireExactUniqueSet(responseRubricKinds, rubricKinds, 'rubric kinds');
  if (!Array.isArray(response.evidence) || response.evidence.length === 0) {
    throw new Error('evidence must be a non-empty array');
  }
  const evidenceIds = [];
  for (const item of response.evidence) {
    if (
      !item
      || typeof item.id !== 'string'
      || item.id.trim() === ''
      || typeof item.kind !== 'string'
      || item.kind.trim() === ''
      || typeof item.detail !== 'string'
      || item.detail.trim() === ''
    ) {
      throw new Error('evidence entries require an ID, kind, and detail');
    }
    evidenceIds.push(item.id);
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('evidence IDs must be unique');
  requireTraceEntries(
    response.deliberatelyRejectedRecommendations,
    'deliberately rejected recommendation',
    'type',
  );
  if (!response.communication || typeof response.communication !== 'object') {
    throw new Error('communication must be an object');
  }
  for (const field of mustDo.communicationFields) {
    if (typeof response.communication[field] !== 'string' || response.communication[field].trim() === '') {
      throw new Error(`must-do communication field is missing ${field}`);
    }
  }
}

async function runScenario(scenario) {
  requireRunning();
  const temporaryRoot = await mkdtemp(join(tmpdir(), `keel-behavior-${scenario.id}-`));
  activeTemporaryRoots.add(temporaryRoot);
  const repository = join(temporaryRoot, 'repository');
  const schemaPath = join(temporaryRoot, 'output-schema.json');
  const outputPath = join(temporaryRoot, 'response.json');

  try {
    await copyDirectoryContents(join(fixturesRoot, scenario.id), repository);
    const gitEnvironment = isolatedGitEnvironment();
    requireRunning();
    const gitResult = await run('git', ['init', '--quiet', '--template='], {
      cwd: repository,
      env: gitEnvironment,
      timeoutMs: 10_000,
      temporaryRoot,
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
      requireRunning();
      const gitSetup = await run('git', args, {
        cwd: repository,
        env: gitEnvironment,
        timeoutMs: 10_000,
        temporaryRoot,
      });
      if (gitSetup.code !== 0) throw new Error('could not prepare temporary repository');
    }
    await writeFile(schemaPath, `${JSON.stringify(outputSchema)}\n`);

    requireRunning();
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
      { cwd: repository, env: process.env, timeoutMs: 600_000, temporaryRoot },
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
    if (!retainedTemporaryRoots.has(temporaryRoot)) {
      await rm(temporaryRoot, { recursive: true, force: true });
      activeTemporaryRoots.delete(temporaryRoot);
    }
  }
}

let passed = 0;

for (const scenario of manifest.scenarios) {
  if (shuttingDown) break;
  const scenarioTask = runScenario(scenario);
  activeScenarioTasks.add(scenarioTask);
  try {
    await scenarioTask;
    passed += 1;
    console.log(`PASS ${scenario.id}`);
  } catch (error) {
    if (!shuttingDown) console.log(`FAIL ${scenario.id}: ${error.message}`);
  } finally {
    activeScenarioTasks.delete(scenarioTask);
  }
}

if (!shuttingDown) {
  const allPassed = passed === manifest.scenarios.length;
  console.log(`${allPassed ? 'PASS' : 'FAIL'} ${passed}/${manifest.scenarios.length} behavior scenarios`);
  if (!allPassed) process.exitCode = 1;
}
