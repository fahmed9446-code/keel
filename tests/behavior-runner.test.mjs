import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const rootPath = fileURLToPath(new URL('../', import.meta.url));
const runnerPath = fileURLToPath(new URL('./run-behavior-tests.mjs', import.meta.url));
const fakeCodexPath = fileURLToPath(new URL('./helpers/fake-codex.mjs', import.meta.url));
const scenariosUrl = new URL('./scenarios.json', import.meta.url);
const fixturesUrl = new URL('./fixtures/behavior-scenarios/', import.meta.url);

async function runWithFake(mode = 'pass', extraEnv = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'keel-behavior-runner-test-'));
  const logPath = join(scratch, 'calls.jsonl');
  try {
    const result = await execFileAsync(process.execPath, [runnerPath], {
      cwd: rootPath,
      env: {
        ...process.env,
        ...extraEnv,
        KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
        KEEL_FAKE_CODEX_LOG: logPath,
        KEEL_FAKE_CODEX_MODE: mode,
      },
    });
    return { ...result, logPath, scratch };
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.code,
      logPath,
      scratch,
    };
  }
}

async function cleanupRun(run) {
  await rm(run.scratch, { recursive: true, force: true });
}

test('scenario fixtures correspond one-to-one with the six regression contracts', async () => {
  const manifest = JSON.parse(await readFile(scenariosUrl, 'utf8'));
  const fixtureEntries = await readdir(fixturesUrl, { withFileTypes: true });
  const fixtureIds = fixtureEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const scenarioIds = manifest.scenarios.map(({ id }) => id).sort();

  assert.equal(manifest.benchmark, false);
  assert.deepEqual(fixtureIds, scenarioIds);
  assert.equal(fixtureIds.length, 6);
});

test('mechanically induced reading fixture has small permanent guidance and material induced context', async () => {
  const fixture = new URL('./fixtures/behavior-scenarios/mechanically-induced-reading/', import.meta.url);
  const [guidance, startup, optionalIdeas] = await Promise.all([
    readFile(new URL('AGENTS.md', fixture), 'utf8'),
    readFile(new URL('docs/startup.md', fixture), 'utf8'),
    readFile(new URL('docs/ideas.md', fixture), 'utf8'),
  ]);

  assert.ok(Buffer.byteLength(guidance) < 512);
  assert.match(guidance, /Before every task, read `docs\/startup\.md`/);
  assert.ok(Buffer.byteLength(startup) >= 4_096);
  assert.ok(Buffer.byteLength(optionalIdeas) < 512);
});

test('conflicting authority fixture makes superseded history an active architecture dependency', async () => {
  const fixture = new URL(
    './fixtures/behavior-scenarios/conflicting-current-and-historical-authority/',
    import.meta.url,
  );
  const [guidance, historicalPlan] = await Promise.all([
    readFile(new URL('AGENTS.md', fixture), 'utf8'),
    readFile(new URL('docs/old-plan.md', fixture), 'utf8'),
  ]);

  assert.match(guidance, /`docs\/old-plan\.md` is superseded history/);
  assert.match(guidance, /use `docs\/old-plan\.md` for architecture decisions/i);
  assert.match(historicalPlan, /Historical only/);
});

test('runner uses one correctly assembled fresh Codex process and repository per scenario', async () => {
  const run = await runWithFake();
  try {
    assert.equal(run.exitCode, undefined, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(
      run.stdout,
      [
        'PASS clean-repository',
        'PASS bloated-permanent-context',
        'PASS mechanically-induced-reading',
        'PASS conflicting-current-and-historical-authority',
        'PASS solo-local-first-with-human-review',
        'PASS material-technical-review-gap',
        'PASS 6/6 behavior scenarios',
        '',
      ].join('\n'),
    );

    const calls = (await readFile(run.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 6);
    assert.equal(new Set(calls.map(({ repository }) => repository)).size, 6);
    assert.equal(new Set(calls.map(({ outputPath }) => outputPath)).size, 6);

    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 8), [
        '-a',
        'never',
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--sandbox',
        'read-only',
        '-C',
      ]);
      assert.equal(call.args[8], call.repository);
      assert.equal(call.args[9], '--output-schema');
      assert.equal(call.args[11], '--output-last-message');
      assert.equal(call.args.length, 13);
      assert.equal(call.skillInstalled, true);
      assert.equal(call.fixtureInstalled, true);
      assert.equal(call.repositoryIsClean, true);
      assert.equal(call.promptProvided, true);
      assert.equal(call.schemaValid, true);
      assert.equal(call.outputIsOutsideRepository, true);
      await assert.rejects(access(call.repository));
    }
  } finally {
    await cleanupRun(run);
  }
});

test('runner rejects a response that is not structured JSON', async () => {
  const run = await runWithFake('malformed-first');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL clean-repository: response is not valid JSON$/m);
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
    assert.doesNotMatch(run.stdout, /prompt|transcript|token|cost|score/i);
    assert.equal(run.stderr, '');
  } finally {
    await cleanupRun(run);
  }
});

test('runner requires unique trace IDs for every universal rubric kind', async () => {
  const run = await runWithFake('missing-rubric-first');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL clean-repository: rubric kinds do not match the scenario contract$/m);
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
    assert.equal(run.stderr, '');
  } finally {
    await cleanupRun(run);
  }
});

test('runner enforces each scenario maximum proposed package count', async () => {
  const run = await runWithFake('too-many-first');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL clean-repository: proposed 1 packages; maximum is 0$/m);
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
    assert.equal(run.stderr, '');
  } finally {
    await cleanupRun(run);
  }
});

test('runner emits a bounded semantic diagnostic without raw or private response content', async () => {
  const run = await runWithFake('bounded-semantic-diagnostic-first');
  try {
    assert.equal(run.exitCode, 1, run.stdout);
    const line = run.stdout.split('\n').find((value) => value.startsWith('DIAG clean-repository: '));
    assert.ok(line, run.stdout);
    assert.ok(Buffer.byteLength(line, 'utf8') <= 2_048, `diagnostic was ${Buffer.byteLength(line)} bytes`);
    assert.doesNotMatch(run.stdout, /PRIVATE-DIAGNOSTIC-SENTINEL/);
    const diagnostic = JSON.parse(line.slice('DIAG clean-repository: '.length));
    assert.deepEqual(diagnostic, {
      schemaVersion: 1,
      scenarioId: 'clean-repository',
      available: true,
      decision: 'changes-proposed',
      proposedPackages: {
        count: 100,
        semanticTypes: ['add-hosted-control', 'clarify-current-authority'],
        truncated: false,
      },
      expected: {
        decision: 'no-change',
        anyProposalTypes: [],
        maximumProposedChangePackages: 0,
        communicationFields: ['mainTakeaway', 'technicalEvidence'],
      },
      actual: {
        matchedMustDoOutcomes: ['communication:mainTakeaway', 'communication:technicalEvidence'],
        unmatchedMustDoOutcomes: ['decision:no-change'],
        mustNotDoViolations: ['add-hosted-control'],
      },
      deliberatelyRejectedRecommendationCount: 1,
    });
  } finally {
    await cleanupRun(run);
  }
});

test('runner emits a path-safe unavailable diagnostic when no structured response exists', async () => {
  const run = await runWithFake('malformed-first');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(
      run.stdout,
      /^DIAG clean-repository: \{"schemaVersion":1,"scenarioId":"clean-repository","available":false,"reason":"structured-response-unavailable"\}$/m,
    );
  } finally {
    await cleanupRun(run);
  }
});

test('runner keeps scenario-specific expected answers out of the Codex prompt', async () => {
  const run = await runWithFake();
  try {
    assert.equal(run.exitCode, undefined, run.stderr);
    const calls = (await readFile(run.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 6);
    assert.ok(calls.every(({ promptLeaksOracle }) => promptLeaksOracle === false));
  } finally {
    await cleanupRun(run);
  }
});

test('runner requires unique trace IDs for deliberately rejected recommendations', async () => {
  const run = await runWithFake('duplicate-rejection-first');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL clean-repository: deliberately rejected recommendation IDs must be unique$/m);
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner allows additional unique rejected-recommendation labels', async () => {
  const run = await runWithFake('extra-valid-rejection-first');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner judges scenarios by observable outcomes rather than exact evidence or rejection shapes', async () => {
  for (const mode of [
    'clean-equivalent-outcome',
    'bloated-equivalent-outcome',
    'authority-equivalent-outcome',
  ]) {
    const run = await runWithFake(mode);
    try {
      assert.equal(run.exitCode, undefined, `${mode}: ${run.stdout}`);
      assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
    } finally {
      await cleanupRun(run);
    }
  }
});

test('scenario oracle exposes only must-do, must-not-do, and maximum-package outcome checks', async () => {
  const manifest = JSON.parse(await readFile(scenariosUrl, 'utf8'));
  const forbiddenShapeFields = [
    'allowedProposalTypes',
    'exactProposalTypes',
    'requiredAnyProposalTypes',
    'requiredRejectionTypes',
    'requiredEvidenceKinds',
    'requiredCommunicationFields',
    'communicationPrefixes',
  ];

  for (const scenario of manifest.scenarios) {
    assert.deepEqual(Object.keys(scenario.outcomeContract).sort(), [
      'maximumProposedChangePackages',
      'mustDo',
      'mustNotDo',
    ]);
    for (const field of forbiddenShapeFields) assert.equal(field in scenario, false, `${scenario.id}: ${field}`);
  }
});

test('runner does not require an exact rejected-recommendation list', async () => {
  const run = await runWithFake('missing-required-rejection-first');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner accepts semantically phrased rejection labels outside a fixed catalog', async () => {
  const run = await runWithFake('unknown-rejection-first');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner accepts either valid proposal alternative for bloated permanent context', async () => {
  for (const mode of ['pass', 'bloated-remove-unconditional-read']) {
    const run = await runWithFake(mode);
    try {
      assert.equal(run.exitCode, undefined, `${mode}: ${run.stdout}`);
      assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
    } finally {
      await cleanupRun(run);
    }
  }
});

test('runner accepts equivalent context-reduction outcomes for mechanically induced reading', async () => {
  const run = await runWithFake('induced-equivalent-context-reduction');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner enforces observable must-do communication dimensions without matching wording', async () => {
  const run = await runWithFake('missing-outcome-communication');
  try {
    assert.equal(run.exitCode, 1, run.stdout);
    assert.match(
      run.stdout,
      /^FAIL mechanically-induced-reading: must-do communication field is missing inducedReading$/m,
    );
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner rejects a missing required outcome and a forbidden outcome for bloated permanent context', async () => {
  for (const [mode, message] of [
    ['bloated-unrelated-proposal', 'proposal types do not match the scenario contract'],
    ['bloated-forbidden-proposal', 'proposal type is forbidden replace-handbook'],
  ]) {
    const run = await runWithFake(mode);
    try {
      assert.equal(run.exitCode, 1, `${mode}: ${run.stdout}`);
      assert.match(run.stdout, new RegExp(`^FAIL bloated-permanent-context: ${message}$`, 'm'));
      assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
    } finally {
      await cleanupRun(run);
    }
  }
});

test('runner rejects a forbidden recommendation type independently of trace IDs', async () => {
  const run = await runWithFake('forbidden-solo-proposal');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL solo-local-first-with-human-review: proposal type is forbidden add-ai-review$/m);
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner accepts correct semantic behavior with different non-empty trace IDs', async () => {
  const run = await runWithFake('alternate-trace-ids');
  try {
    assert.equal(run.exitCode, undefined, run.stderr);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner allows additional evidence kinds from the universal catalog', async () => {
  const run = await runWithFake('extra-valid-evidence-first');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner accepts different non-empty evidence selections for the same observable outcome', async () => {
  const run = await runWithFake('missing-required-evidence-first');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner accepts concise evidence labels outside a fixed semantic catalog', async () => {
  const run = await runWithFake('unknown-evidence-first');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner rejects a forbidden semantic recommendation type regardless of its trace ID', async () => {
  const run = await runWithFake('wrong-semantic-type');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL solo-local-first-with-human-review: proposal type is forbidden add-ai-review$/m);
    assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner isolates repository setup from inherited Git configuration', async () => {
  const run = await runWithFake('pass', {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'true',
  });
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner terminates its child and removes temporary data when interrupted', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'keel-behavior-signal-test-'));
  const logPath = join(scratch, 'calls.jsonl');
  const child = spawn(process.execPath, [runnerPath], {
    cwd: rootPath,
    env: {
      ...process.env,
      KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
      KEEL_FAKE_CODEX_LOG: logPath,
      KEEL_FAKE_CODEX_MODE: 'hang-first',
    },
    stdio: 'ignore',
  });

  let fakePid;
  try {
    let call;
    for (let attempt = 0; attempt < 100 && !call; attempt += 1) {
      try {
        call = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n')[0]);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(call, 'fake executable did not start');
    fakePid = call.pid;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await assert.rejects(access(call.repository));
    assert.throws(() => process.kill(fakePid, 0), { code: 'ESRCH' });
    assert.doesNotMatch(await readFile(logPath, 'utf8'), /<scenario-contract>|Use the installed/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (fakePid) {
      try {
        process.kill(fakePid, 'SIGKILL');
      } catch {}
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test('runner refuses a subprocess spawn attempted after shutdown starts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'keel-behavior-spawn-gate-test-'));
  const logPath = join(scratch, 'calls.jsonl');
  const markerPath = join(scratch, 'spawned-after-shutdown');
  const child = spawn(process.execPath, [runnerPath], {
    cwd: rootPath,
    env: {
      ...process.env,
      KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
      KEEL_FAKE_CODEX_LOG: logPath,
      KEEL_FAKE_CODEX_MODE: 'hang-first',
      KEEL_BEHAVIOR_TEST_POST_SHUTDOWN_SPAWN_MARKER: markerPath,
    },
    stdio: 'ignore',
  });
  let fakePid;
  try {
    let call;
    for (let attempt = 0; attempt < 100 && !call; attempt += 1) {
      try { call = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n')[0]); }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(call, 'fake executable did not start');
    fakePid = call.pid;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await assert.rejects(access(markerPath));
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (fakePid) { try { process.kill(fakePid, 'SIGKILL'); } catch {} }
    await rm(scratch, { recursive: true, force: true });
  }
});

test('runner retains temporary data and reports failure when forced exit is unconfirmed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'keel-behavior-unconfirmed-exit-test-'));
  const logPath = join(scratch, 'calls.jsonl');
  const child = spawn(process.execPath, [runnerPath], {
    cwd: rootPath,
    env: {
      ...process.env,
      KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
      KEEL_FAKE_CODEX_LOG: logPath,
      KEEL_FAKE_CODEX_MODE: 'hang-first',
      KEEL_BEHAVIOR_TEST_FORCE_UNCONFIRMED_EXIT: '1',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let fakePid;
  let repository;
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  try {
    let call;
    for (let attempt = 0; attempt < 100 && !call; attempt += 1) {
      try { call = JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n')[0]); }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(call, 'fake executable did not start');
    fakePid = call.pid;
    repository = call.repository;
    child.kill('SIGTERM');
    const [exitCode] = await new Promise((resolve) => child.once('exit', (...values) => resolve(values)));
    assert.equal(exitCode, 1);
    assert.equal(stdout, 'FAIL cleanup: child exit unconfirmed; temporary data retained\n');
    await access(repository);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (fakePid) { try { process.kill(fakePid, 'SIGKILL'); } catch {} }
    if (repository) await rm(dirname(repository), { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
