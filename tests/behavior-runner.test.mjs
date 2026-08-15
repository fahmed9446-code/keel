import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

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
        KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
        KEEL_FAKE_CODEX_LOG: logPath,
        KEEL_FAKE_CODEX_MODE: mode,
        ...extraEnv,
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

async function waitForFirstCall(logPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse((await readFile(logPath, 'utf8')).trim().split('\n')[0]);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return undefined;
}

test('scenario fixtures correspond one-to-one with the six non-benchmark contracts', async () => {
  const manifest = JSON.parse(await readFile(scenariosUrl, 'utf8'));
  const fixtureEntries = await readdir(fixturesUrl, { withFileTypes: true });
  const fixtureIds = fixtureEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const scenarioIds = manifest.scenarios.map(({ id }) => id).sort();

  assert.equal(manifest.benchmark, false);
  assert.deepEqual(fixtureIds, scenarioIds);
  assert.equal(fixtureIds.length, 6);
  for (const scenario of manifest.scenarios) {
    assert.deepEqual(Object.keys(scenario.outcomeContract).sort(), [
      'maximumProposedChangePackages',
      'mustDo',
      'mustNotDo',
    ]);
  }
});

test('mechanically induced reading fixture separates small permanent guidance from material induced context', async () => {
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
  const fixture = new URL('./fixtures/behavior-scenarios/conflicting-current-and-historical-authority/', import.meta.url);
  const [guidance, historicalPlan] = await Promise.all([
    readFile(new URL('AGENTS.md', fixture), 'utf8'),
    readFile(new URL('docs/old-plan.md', fixture), 'utf8'),
  ]);

  assert.match(guidance, /`docs\/old-plan\.md` is superseded history/);
  assert.match(guidance, /use `docs\/old-plan\.md` for architecture decisions/i);
  assert.match(historicalPlan, /Historical only/);
});

test('runner executes six isolated read-only scenarios without exposing the oracle', async () => {
  const run = await runWithFake();
  try {
    assert.equal(run.exitCode, undefined, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout.trim().split('\n').at(-1), 'PASS 6/6 behavior scenarios');

    const calls = (await readFile(run.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 6);
    assert.equal(new Set(calls.map(({ repository }) => repository)).size, 6);
    assert.equal(new Set(calls.map(({ outputPath }) => outputPath)).size, 6);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 8), [
        '-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '-C',
      ]);
      assert.equal(call.args[8], call.repository);
      assert.equal(call.skillInstalled, true);
      assert.equal(call.fixtureInstalled, true);
      assert.equal(call.repositoryIsClean, true);
      assert.equal(call.promptProvided, true);
      assert.equal(call.promptLeaksOracle, false);
      assert.equal(call.schemaValid, true);
      assert.equal(call.outputIsOutsideRepository, true);
      await assert.rejects(access(call.repository));
    }
  } finally {
    await cleanupRun(run);
  }
});

test('runner distinguishes completed behavior results from unavailable prerequisites', async (t) => {
  const missingBinary = join(tmpdir(), 'keel-prerequisite-does-not-exist');
  const cases = [
    { name: 'all pass', mode: 'pass', env: {}, exitCode: undefined, summary: 'PASS 6/6 behavior scenarios' },
    { name: 'behavior failure', mode: 'forbidden', env: {}, exitCode: 1, summary: 'FAIL 5/6 behavior scenarios' },
    {
      name: 'post-preflight invocation failure', mode: 'post-preflight-failure', env: {},
      exitCode: 1, summary: 'FAIL 5/6 behavior scenarios',
    },
    {
      name: 'Codex unavailable', mode: 'pass',
      env: { KEEL_BEHAVIOR_CODEX_BIN: missingBinary }, exitCode: 2,
      summary: 'UNAVAILABLE behavior prerequisites: Codex CLI not found',
    },
    {
      name: 'Git unavailable', mode: 'pass',
      env: { KEEL_BEHAVIOR_GIT_BIN: missingBinary }, exitCode: 2,
      summary: 'UNAVAILABLE behavior prerequisites: Git not found',
    },
  ];
  for (const expectation of cases) {
    await t.test(expectation.name, async () => {
      const run = await runWithFake(expectation.mode, expectation.env);
      try {
        assert.equal(run.exitCode, expectation.exitCode, run.stdout);
        assert.match(run.stdout, new RegExp(`^${expectation.summary}$`, 'm'));
        if (expectation.name === 'post-preflight invocation failure') {
          assert.match(run.stdout, /^FAIL clean-repository: codex exited 17$/m);
          assert.doesNotMatch(run.stdout, /^UNAVAILABLE behavior prerequisites:/m);
        }
        if (expectation.exitCode === 2) {
          assert.doesNotMatch(run.stdout, /^(?:PASS|FAIL) \d+\/6 behavior scenarios$/m);
          await assert.rejects(access(run.logPath));
        }
      } finally {
        await cleanupRun(run);
      }
    });
  }
});

test('runner accepts semantically equivalent observable outcomes', async () => {
  const run = await runWithFake('equivalent');
  try {
    assert.equal(run.exitCode, undefined, run.stdout);
    assert.match(run.stdout, /^PASS 6\/6 behavior scenarios$/m);
  } finally {
    await cleanupRun(run);
  }
});

test('runner rejects missing, forbidden, over-cap, and incomplete observable outcomes', async (t) => {
  const cases = [
    ['missing-required', 'bloated-permanent-context', 'proposal types do not match the scenario contract'],
    ['forbidden', 'solo-local-first-with-human-review', 'proposal type is forbidden add-ai-review'],
    ['too-many', 'clean-repository', 'proposed 1 packages; maximum is 0'],
    ['missing-communication', 'mechanically-induced-reading', 'must-do communication field is missing inducedReading'],
  ];
  for (const [mode, scenario, message] of cases) {
    await t.test(mode, async () => {
      const run = await runWithFake(mode);
      try {
        assert.equal(run.exitCode, 1, run.stdout);
        assert.match(run.stdout, new RegExp(`^FAIL ${scenario}: ${message}$`, 'm'));
        assert.match(run.stdout, /^FAIL 5\/6 behavior scenarios$/m);
      } finally {
        await cleanupRun(run);
      }
    });
  }
});

test('runner rejects malformed output with a path-safe unavailable diagnostic', async () => {
  const run = await runWithFake('malformed');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL clean-repository: response is not valid JSON$/m);
    assert.match(
      run.stdout,
      /^DIAG clean-repository: \{"schemaVersion":1,"scenarioId":"clean-repository","available":false,"reason":"structured-response-unavailable"\}$/m,
    );
    assert.doesNotMatch(run.stdout, /prompt|transcript|token|cost|score/i);
  } finally {
    await cleanupRun(run);
  }
});

test('runner emits bounded semantic failure facts without raw or private response content', async () => {
  const run = await runWithFake('bounded-diagnostic');
  try {
    assert.equal(run.exitCode, 1, run.stdout);
    const line = run.stdout.split('\n').find((value) => value.startsWith('DIAG clean-repository: '));
    assert.ok(line, run.stdout);
    assert.ok(Buffer.byteLength(line, 'utf8') <= 2_048);
    assert.doesNotMatch(run.stdout, /PRIVATE-DIAGNOSTIC-SENTINEL/);
    const diagnostic = JSON.parse(line.slice('DIAG clean-repository: '.length));
    assert.equal(diagnostic.scenarioId, 'clean-repository');
    assert.equal(diagnostic.decision, 'changes-proposed');
    assert.equal(diagnostic.proposedPackages.count, 100);
    assert.deepEqual(diagnostic.actual.unmatchedMustDoOutcomes, ['decision:no-change']);
    assert.deepEqual(diagnostic.actual.mustNotDoViolations, ['add-hosted-control']);
  } finally {
    await cleanupRun(run);
  }
});

test('runner preserves unique trace IDs without assigning semantics to their wording', async () => {
  const run = await runWithFake('duplicate-id');
  try {
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /^FAIL clean-repository: deliberately rejected recommendation IDs must be unique$/m);
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

test('runner terminates its child and removes confirmed temporary data when interrupted', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'keel-behavior-signal-test-'));
  const logPath = join(scratch, 'calls.jsonl');
  const child = spawn(process.execPath, [runnerPath], {
    cwd: rootPath,
    env: {
      ...process.env,
      KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
      KEEL_FAKE_CODEX_LOG: logPath,
      KEEL_FAKE_CODEX_MODE: 'hang',
    },
    stdio: 'ignore',
  });
  let fakePid;
  try {
    const call = await waitForFirstCall(logPath);
    assert.ok(call, 'fake executable did not start');
    fakePid = call.pid;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await assert.rejects(access(call.repository));
    assert.throws(() => process.kill(fakePid, 0), { code: 'ESRCH' });
    assert.doesNotMatch(await readFile(logPath, 'utf8'), /<scenario-contract>|Use the installed/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (fakePid) { try { process.kill(fakePid, 'SIGKILL'); } catch {} }
    await rm(scratch, { recursive: true, force: true });
  }
});

test('runner retains temporary data and fails closed when child exit is unconfirmed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'keel-behavior-unconfirmed-exit-test-'));
  const logPath = join(scratch, 'calls.jsonl');
  const child = spawn(process.execPath, [runnerPath], {
    cwd: rootPath,
    env: {
      ...process.env,
      KEEL_BEHAVIOR_CODEX_BIN: fakeCodexPath,
      KEEL_FAKE_CODEX_LOG: logPath,
      KEEL_FAKE_CODEX_MODE: 'hang',
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
    const call = await waitForFirstCall(logPath);
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
