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
const contractMatch = prompt.match(/<scenario-contract>([\s\S]*?)<\/scenario-contract>/);

if (!contractMatch || !repository || !outputPath) {
  process.exitCode = 2;
} else {
  const scenario = JSON.parse(contractMatch[1]);
  const rubricIds = [
    ...scenario.mustDo.map((_, index) => `${scenario.id}:must-do:${index + 1}`),
    ...scenario.mustNotDo.map((_, index) => `${scenario.id}:must-not-do:${index + 1}`),
    ...scenario.communicationRequirements.map(
      (_, index) => `${scenario.id}:communication:${index + 1}`,
    ),
  ];
  const response = {
    decision: scenario.requiredProposedChangeIds.length === 0 ? 'no-change' : 'changes-proposed',
    proposedChangeIds: scenario.requiredProposedChangeIds,
    rubricChecks: rubricIds.map((id) => ({ id, passed: true, evidence: `Satisfied ${id}` })),
    evidence: [`Synthetic evidence for ${scenario.id}`],
    deliberatelyRejectedRecommendations: scenario.requiredRejectedRecommendationIds,
  };

  const mode = process.env.KEEL_FAKE_CODEX_MODE;
  if (scenario.id === 'clean-repository' && mode === 'hang-first') {
    await appendFile(
      process.env.KEEL_FAKE_CODEX_LOG,
      `${JSON.stringify({ args: args.slice(0, -1), repository, promptProvided: true })}\n`,
    );
    await new Promise(() => setInterval(() => {}, 60_000));
  }
  if (scenario.id === 'clean-repository' && mode === 'malformed-first') {
    await writeFile(outputPath, 'not json\n');
  } else {
    if (scenario.id === 'clean-repository' && mode === 'missing-rubric-first') {
      response.rubricChecks.shift();
    }
    if (scenario.id === 'clean-repository' && mode === 'too-many-first') {
      response.decision = 'changes-proposed';
      response.proposedChangeIds = ['unearned-change'];
    }
    if (scenario.id === 'solo-local-first-with-human-review' && mode === 'forbidden-solo-proposal') {
      response.decision = 'changes-proposed';
      response.proposedChangeIds = ['install-independent-ai-review'];
    }
    await writeFile(outputPath, `${JSON.stringify(response)}\n`);
  }

  let skillInstalled = true;
  let fixtureInstalled = true;
  let schemaValid = true;
  try {
    await access(join(repository, '.agents/skills/building-agent-harness/SKILL.md'));
  } catch {
    skillInstalled = false;
  }
  try {
    await access(join(repository, 'AGENTS.md'));
  } catch {
    fixtureInstalled = false;
  }
  try {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    schemaValid = schema.required.includes('decision')
      && schema.required.includes('rubricChecks')
      && schema.additionalProperties === false;
  } catch {
    schemaValid = false;
  }
  const repositoryIsClean =
    execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }) === '';

  await appendFile(
    process.env.KEEL_FAKE_CODEX_LOG,
    `${JSON.stringify({
      args: args.slice(0, -1),
      repository,
      skillInstalled,
      fixtureInstalled,
      repositoryIsClean,
      promptProvided: prompt.startsWith('Use the installed building-agent-harness skill'),
      schemaValid,
      outputPath,
      outputIsOutsideRepository: dirname(outputPath) === dirname(repository),
    })}\n`,
  );
}
