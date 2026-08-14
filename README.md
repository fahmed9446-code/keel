# Keel

**Build fast. Stay on course.**

Keel helps AI-built codebases stay fast, understandable, and on course as they grow. It audits the instructions, context, handoffs, review habits, and safety boundaries that coding agents work with, then suggests only changes supported by the repository it finds.

**Already have a clean setup? That's fine.** The audit is read-only, recommendations are not automatic, and **No meaningful changes required** is a valid result. You remain in control: approve all, some, or none of what Keel proposes. An optional scanner can collect boring facts for the audit; it does not make judgments.

## Who Keel is for

Keel is for solo founders, vibe coders, indie hackers, product and design builders, and heavy coding-agent users. It does not replace engineering judgment or require a large-team workflow.

It may be useful when you repeatedly explain the same project facts, when plans, handoffs, and documents have accumulated, or when a long task is hard to resume after context is lost. It can also help establish multi-agent shared truth, surface drift between current instructions and historical material, and—when the work is consequential and existing review is insufficient—propose a second pair of eyes.

## What Keel can help with

Depending on the repository, a small, evidence-backed change may offer:

- **Less wasted AI context** and **potentially lower unnecessary token use** by keeping permanent instructions short.
- **Less repeated explanation** and **easier long-task recovery** through clearer, repository-owned handoffs.
- **Reduced drift** and **clearer authority** when current guidance and old plans disagree.
- **Conditional independent review** when risk justifies it and no meaningful review already exists.
- **Safer dangerous operations** through explicit, separate permission gates, without making safety promises.
- **Less unnecessary process** by rejecting infrastructure that has not earned its maintenance cost.
- **Better maintainability** through one canonical source of shared truth and thin agent-specific routing.

These are potential benefits, not promised outcomes. Keel does not promise a percentage improvement, faster delivery, correctness, bug prevention, or complete safety.

## The simple idea

An AI coding agent needs the right information at the right time—not every piece of information all the time. Keel uses a familiar mental model:

- A **sticky note** is the small set of instructions that should always be visible.
- **Instruction manuals** are deeper references opened only when the task needs them.
- A **work notebook** records a useful plan or handoff so a long task can be resumed.
- **Guardrails** describe boundaries around risky work.
- A **second pair of eyes** reviews consequential changes when independent review is justified.
- A **permission gate** keeps installation and dangerous actions under human approval.
- The **code** remains the product itself, with its tests and repository truth.

Not every repository receives every mechanism. Keel audits first and may recommend none of them.

## Before Keel / After Keel

This is an example, not a diagnosis of every AI-built repository:

```text
Before Keel
Every task reloads duplicated instructions and several historical plans.
After Keel
One short instruction surface points the agent to the relevant canonical reference.
```

The application code need not change. The useful outcome may simply be a clearer route to information—or a finding that the current route is already good.

## What Keel does not assume

- Keel does not presume that a repository is broken or that more infrastructure is better.
- It does not automatically rewrite the application. The audit is read-only.
- It does not automatically delete documentation.
- It does not require GitHub, pull requests, hosted CI, or another hosted service as the target repository's control plane.
- It does not automatically install CI, review systems, ADRs, invariant files, skills, or task-memory systems.
- It does not automatically install any recommendation. Exact human approval comes first.
- No change is a valid outcome.

## How Keel works

1. **Looks without touching.** Keel inspects the repository read-only.
2. **Explains plainly.** It separates facts from judgment and shows what, if anything, is getting in the way.
3. **Proposes a small set.** It offers at most five evidence-backed change packages—or none.
4. **Waits for your choice.** You approve all, some, or none using the listed change IDs.
5. **Installs only what you approved.** It makes the smallest approved edits and verifies them. Dangerous operations require another approval immediately before they run.
6. **Behaves sensibly on rerun.** When you explicitly approved persisted state, Keel avoids repeating satisfied or unchanged declined recommendations.
7. **Helps reverse managed changes safely.** It proposes an exact rollback and treats later human edits as conflicts instead of deletion targets.

The complete workflow is defined by the [building-agent-harness skill](skills/building-agent-harness/SKILL.md).

## Supported agents

The methodology is shared across agents, but native mechanics differ. Codex is Keel V1's fully runtime-verified reference implementation. Claude Code and Gemini CLI have documented mappings, with their limitations labeled rather than inferred from Codex.

| Agent | V1 support |
| --- | --- |
| Codex | Fully runtime-verified V1 reference for project skill discovery, ephemeral execution, the read-only sandbox, and scanner + audit behavior with `codex-cli 0.133.0`; supported methodology also covers exact approval, installation, rerun restraint, and uninstall |
| Claude Code | Native project installation and capability mapping are documented; not locally runtime-verified |
| Gemini CLI | Native project installation and capability mapping are documented; not locally runtime-verified |

See the dated [Codex](skills/building-agent-harness/references/codex.md), [Claude Code](skills/building-agent-harness/references/claude-code.md), and [Gemini CLI](skills/building-agent-harness/references/gemini-cli.md) references for exact capability and installation limits.

## Quick start

Clone Keel and enter its directory:

```bash
git clone https://github.com/fahmed9446-code/keel.git
cd keel
```

Copy the complete `building-agent-harness` directory into the target project's native skill location. Replace `/path/to/project` with that project's path.

### Codex

```bash
mkdir -p /path/to/project/.agents/skills
cp -R skills/building-agent-harness /path/to/project/.agents/skills/
```

### Claude Code

```bash
mkdir -p /path/to/project/.claude/skills
cp -R skills/building-agent-harness /path/to/project/.claude/skills/
```

### Gemini CLI

```bash
mkdir -p /path/to/project/.gemini/skills
cp -R skills/building-agent-harness /path/to/project/.gemini/skills/
```

Start that agent in the target repository and ask:

```text
Use building-agent-harness to audit this repository's coding-agent instructions,
memory, context loading, review independence, and architectural drift.
Keep the audit read-only.
```

Copy the whole directory: the skill, scanner, registry, metadata, and references are one distribution unit.

## Technical architecture

Keel deliberately stays small:

```text
one portable reasoning skill
+ one optional dependency-free read-only scanner
+ small lazy agent references
+ minimal state only after an approved installation or approved persisted decision
```

The scanner gathers repository facts. The skill makes semantic and architectural judgments. Agent references describe the supported native mechanics. The target repository—not Keel—decides what permanent artifacts and controls are justified.

Shared architecture, decisions, runbooks, and invariants should remain canonical. Agent-specific files should be thin routing surfaces, not independently maintained copies of repository truth. Keel is not a hosted service, benchmark, adapter SDK, review platform, CI product, policy engine, telemetry system, or audit database.

### Native locations

- Codex project: `.agents/skills/building-agent-harness/`; user: `$HOME/.agents/skills/building-agent-harness/`.
- Claude Code project: `.claude/skills/building-agent-harness/`; user: `~/.claude/skills/building-agent-harness/`.
- Gemini CLI project: `.gemini/skills/building-agent-harness/`. Keel V1 does not guess a user location; verify it against current official documentation at installation time.

### Review and control-plane limits

Independent technical review is conditional. Keel proposes one lightweight, read-only, on-demand procedure only when repository risk makes same-context self-review material and no meaningful human or independent review already exists. It does not build a review service, database, scoring system, CI reviewer, or persistent review archive. Fresh context can reduce shared reasoning history; it is not a security boundary against repository instructions.

Keel uses GitHub for its own distribution and collaboration. That is not evidence that a target repository needs GitHub, pull requests, hosted CI, branch protection, or another hosted control plane. Keel evaluates the target's real operating model and keeps unjustified hosted controls out of the change set. See [independent technical review](skills/building-agent-harness/references/review-method.md) and [control-plane fit](skills/building-agent-harness/references/control-plane-method.md).

## Optional scanner

The scanner is an optional boring-facts collector, not a judgment maker. An agent can instead use its native read-only tools. To run the scanner manually from the Keel repository root:

```bash
node skills/building-agent-harness/scripts/scan-repo.mjs --root /path/to/project
```

If Keel is already installed for a Codex project, for example:

```bash
node /path/to/project/.agents/skills/building-agent-harness/scripts/scan-repo.mjs --root /path/to/project
```

### Evidence boundary

Scanner schema 2 reports two deliberately separate evidence lanes:

- **Snapshot evidence:** tracked paths, metadata, and selected content come from a Git index/blob snapshot. This can include staged index content. It is never equivalent to current working-copy truth.
- **Live status evidence:** dirty, staged, untracked, and ignored information consists of path-status-only live facts and counts. The scanner never reads that live content and never enumerates the live directory tree.

Dirty working-copy content, untracked content, and ignored content are explicit content blind spots. Failed Git lanes, unsupported entries, skipped or unreadable snapshot candidates, and other incomplete evidence also trigger `nativeLiveInspectionRequired`. The agent must label any transparent native-agent live inspection separately from scanner snapshot evidence and disclose what remained unseen.

### Output and classification

- The current public format is scanner schema 2 with agent-surface registry `2026-08-14.2`.
- Ordinary serialized output is capped at 32 KiB with explicit deterministic truncation. `--max-output-bytes` may lower the budget, but not below the exact 4 KiB serialized ceiling.
- Classification is lexical and syntactic only. Filenames, paths, links, sizes, Git status, and history patterns are evidence; they are not semantic authority judgments.
- Sensitive-looking paths are summarized by category and tracked status by default. The scanner does not read their values. `--include-sensitive-paths` reveals matching path names only for an explicit diagnostic need; keep that output out of chat unless needed.
- Symbolic links are skipped, and Git subprocesses are configured to avoid hooks, prompts, lazy fetching, and network retrieval. The scanner has no intended network behavior and writes its JSON report only to standard output.

## Approval, state, reruns, and uninstall

### Exact approvals

Keel lists stable change IDs beside each proposed package. Approval of the audit, general encouragement, or approval of one package does not authorize another. Installation accepts an exact subset. Dangerous or destructive work requires separate approval immediately before it runs, even when its package was already approved.

Existing files have an additional gate: automatic editing requires a clean, tracked, stage-zero regular Git blob whose exact bytes match the current file. Dirty, untracked, non-Git, unmerged, symbolic-link, submodule, missing-object, or otherwise unreconstructible files are refusal cases rather than guessed edits.

### State schema 2

After an approved installation—or explicit approval to persist a deferred decision—Keel may write `.keel/state.json`. No approved installation and no approved persisted decision means no state file.

State schema 2 has five top-level fields: `schemaVersion`, `keelVersion`, `installedChangeIds`, `declinedOrDeferredChangeIds`, and `managedArtifacts`. It stores:

- Exact installed IDs and optional declined/deferred reasons.
- An `evidenceFingerprint` of only the normalized facts relevant to a declined or deferred recommendation.
- One repository-relative record per managed path, with a non-empty `changeIds` ownership association.
- Exact-byte `preInstallHash` and `postInstallHash` values.
- A reconstructible `preInstallGitOid` for every existing file Keel edits; Keel-created files omit it and use a null pre-install hash.

It does not store repository evidence, source text, prompts, conversations, transcripts, secrets, or token metrics. The complete contract and example are in the [installation contract](skills/building-agent-harness/references/installation-contract.md).

### Reruns and legacy state

On a rerun, Keel suppresses an installed change only while its associated artifacts still satisfy the recorded `changeIds`. An unchanged declined/deferred recommendation stays quiet while its evidence fingerprint is unchanged. Materially changed evidence may justify resurfacing it. Drift or ambiguous ownership is reported without overwriting files, re-proposing the associated change, or repairing state by guessing.

State schema 1 is legacy read-only. Keel may use it for audit restraint and conflict reporting, but it does not install or uninstall through it. Migration requires a separately approved exact migration package, a clean reconstructible state-file preimage, and independently verifiable artifact-specific ownership. If any proof is ambiguous, the schema 1 file remains byte-for-byte untouched.

### Conflict-safe uninstall

Uninstall starts with an exact rollback proposal and approval:

- A Keel-created file may be removed automatically only when its current hash still matches the recorded post-install hash. A mismatch means later work exists, so the file stays.
- An existing file changed by Keel is never reversed or deleted automatically. Keel reconstructs its exact preimage from `preInstallGitOid`, prepares a reviewable reversal diff, and asks for explicit approval of that diff.
- A partial conflict leaves unresolved artifact records and their change-ID associations in state. `.keel/state.json` is removed last, only after every managed artifact is resolved and no decision remains to preserve.

## Development

Keel has no runtime or development package dependencies. Use Node.js 22 or newer from a clean clone:

```bash
npm test
node skills/building-agent-harness/scripts/scan-repo.mjs --root .
```

The deterministic suite covers scanner schema and limits, sensitive-path handling, zero target mutation, skill discovery, state restraint, and uninstall safety. The non-benchmark behavior runner uses six synthetic repository scenarios and a fresh ephemeral, read-only Codex process per scenario:

```bash
npm run test:behavior
```

See the [behavior runner](tests/run-behavior-tests.mjs) and its [scenario contracts](tests/scenarios.json). It validates decisions, evidence, exact proposal limits, deliberately rejected recommendations, communication fields, process freshness, and cleanup; it is not a quality score or public benchmark.

## Privacy

Keel runs from local files and has no telemetry service. The scanner has no intended network behavior, does not read secret values, redacts sensitive-looking paths by default, and writes its report to standard output. Keel state is minimal and excludes source text, evidence payloads, conversations, secrets, and metrics. Your coding agent still operates under its own filesystem, network, sandbox, and approval configuration; verify those controls for the installed runtime.

## License

Keel is licensed under [Apache-2.0](LICENSE).
