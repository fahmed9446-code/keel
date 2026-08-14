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
const activeChildren = new Set();
const activeTemporaryRoots = new Set();
let shuttingDown = false;

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of activeChildren) child.kill('SIGTERM');
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
    'rubricChecks',
    'evidence',
    'deliberatelyRejectedRecommendations',
  ],
  properties: {
    decision: { enum: ['no-change', 'changes-proposed'] },
    proposedChangeIds: {
      type: 'array',
      items: { type: 'string' },
    },
    rubricChecks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'passed', 'evidence'],
        properties: {
          id: { type: 'string' },
          passed: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
    },
    deliberatelyRejectedRecommendations: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

function rubricEntries(scenario) {
  return [
    ...scenario.mustDo.map((requirement, index) => ({
      id: `${scenario.id}:must-do:${index + 1}`,
      requirement,
      meaning: 'passed means the response does this',
    })),
    ...scenario.mustNotDo.map((requirement, index) => ({
      id: `${scenario.id}:must-not-do:${index + 1}`,
      requirement,
      meaning: 'passed means the response avoids this',
    })),
    ...scenario.communicationRequirements.map((requirement, index) => ({
      id: `${scenario.id}:communication:${index + 1}`,
      requirement,
      meaning: 'passed means the response communicates this',
    })),
  ];
}

function promptFor(scenario) {
  const rubric = rubricEntries(scenario);
  return [
    'Use the installed building-agent-harness skill to audit this synthetic repository read-only.',
    'This is a regression contract. Inspect repository evidence and make the smallest justified decision.',
    'Return only the JSON object required by the supplied output schema.',
    'Use decision "no-change" with no proposed IDs, or "changes-proposed" with stable proposed change IDs.',
    'Return one rubricChecks entry for every listed rubric ID. Mark passed true only when the response satisfies that requirement, and cite concise repository evidence.',
    'For a must-not-do check, passed means the prohibited recommendation was avoided.',
    'Keep factual evidence in evidence and keep deliberately rejected recommendations visible.',
    'Use only allowed proposed change IDs, include every required proposed change ID, and return exactly the required rejected recommendation IDs.',
    '',
    '<scenario-contract>',
    JSON.stringify(scenario),
    '</scenario-contract>',
    '<rubric>',
    JSON.stringify(rubric),
    '</rubric>',
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
    if (!scenario.allowedProposedChangeIds.includes(id)) {
      throw new Error(`proposed change ID is not allowed ${id}`);
    }
  }
  for (const id of scenario.requiredProposedChangeIds) {
    if (!response.proposedChangeIds.includes(id)) {
      throw new Error(`required proposed change ID is missing ${id}`);
    }
  }
  if (response.decision === 'no-change' && response.proposedChangeIds.length !== 0) {
    throw new Error('no-change decision cannot propose packages');
  }
  if (response.decision === 'changes-proposed' && response.proposedChangeIds.length === 0) {
    throw new Error('changes-proposed decision requires a proposed change ID');
  }
  if (!Array.isArray(response.rubricChecks)) {
    throw new Error('rubricChecks must be an array');
  }

  const checksById = new Map();
  for (const check of response.rubricChecks) {
    if (!check || typeof check.id !== 'string' || checksById.has(check.id)) {
      throw new Error('rubric check IDs must be present and unique');
    }
    checksById.set(check.id, check);
  }
  for (const { id } of rubricEntries(scenario)) {
    const check = checksById.get(id);
    if (!check) {
      throw new Error(`missing rubric check ${id}`);
    }
    if (check.passed !== true) {
      throw new Error(`rubric check failed ${id}`);
    }
    if (typeof check.evidence !== 'string' || check.evidence.trim() === '') {
      throw new Error(`rubric check lacks evidence ${id}`);
    }
  }
  if (checksById.size !== rubricEntries(scenario).length) {
    throw new Error('rubricChecks contains unknown IDs');
  }

  requireStringArray(response.evidence, 'evidence');
  requireStringArray(
    response.deliberatelyRejectedRecommendations,
    'deliberatelyRejectedRecommendations',
  );
  const rejected = response.deliberatelyRejectedRecommendations;
  if (
    rejected.length !== scenario.requiredRejectedRecommendationIds.length
    || rejected.some((id) => !scenario.requiredRejectedRecommendationIds.includes(id))
  ) {
    throw new Error('deliberately rejected recommendation IDs do not match the scenario contract');
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
        promptFor(scenario),
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

const manifest = JSON.parse(await readFile(scenariosPath, 'utf8'));
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
