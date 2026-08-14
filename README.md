# Keel

**Build fast. Stay on course.**

Keel audits and improves the repository architecture used by AI coding agents. The scanner gathers facts. The skill makes judgments. Agent references translate those judgments into native mechanics, and the target repository decides what should exist. Human approval remains the installation boundary.

Keel deliberately stays small:

```text
one portable reasoning skill
+ one optional dependency-free read-only scanner
+ small lazy agent references
+ minimal state only after an approved installation
```

It is not a hosted service, benchmark, adapter SDK, review platform, CI product, policy engine, telemetry system, or audit database.

## How it works

1. **Audit:** Keel inspects repository evidence without mutation.
2. **Proposal:** It may offer up to five evidence-backed change packages with exact IDs—or report **No meaningful changes required**.
3. **Approval:** You approve all, some, or none. Dangerous operations require a separate approval immediately before execution.
4. **Install:** Keel applies only approved edits and validates them.
5. **Second run:** Minimal repository state suppresses already-satisfied or unchanged declined recommendations.
6. **Uninstall:** Recorded hashes prevent Keel from silently deleting later user work.

The full workflow lives in [building-agent-harness](skills/building-agent-harness/SKILL.md).

## Support tiers

| Agent | V1 support |
| --- | --- |
| Codex | Runtime-verified reference implementation using `codex-cli 0.133.0` |
| Claude Code | Native installation mapping and dated capability guidance; not locally runtime-verified |
| Gemini CLI | Native installation mapping and dated capability guidance; not locally runtime-verified |

Capability details and limitations are recorded in the [Codex](skills/building-agent-harness/references/codex.md), [Claude Code](skills/building-agent-harness/references/claude-code.md), and [Gemini CLI](skills/building-agent-harness/references/gemini-cli.md) references.

## Install from a clone

Download or clone this public repository using the URL shown by GitHub. Run the following commands from the Keel repository root. These examples install Keel for one project; replace `/path/to/project` with the target repository.

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

Copy the complete directory. The `SKILL.md`, scanner, registry, metadata, and references are one distribution unit. In a multi-agent repository, keep shared architecture, decisions, runbooks, and invariants canonical; agent-specific files should remain thin routing surfaces.

## Run an audit

Start the supported agent in the target repository and ask:

```text
Use building-agent-harness to audit this repository's coding-agent instructions,
memory, context loading, review independence, and architectural drift.
Keep the audit read-only.
```

The optional scanner can gather deterministic evidence before the audit:

```bash
node skills/building-agent-harness/scripts/scan-repo.mjs --root /path/to/project
```

If Keel is already installed in a target repository, run the corresponding installed copy instead—for example:

```bash
node /path/to/project/.agents/skills/building-agent-harness/scripts/scan-repo.mjs --root /path/to/project
```

Ordinary scanner output is capped at 32 KiB. It reports explicit truncation, summarizes sensitive-looking paths by default, and never reads secret values. `--include-sensitive-paths` is an explicit diagnostic option; avoid placing that output in chat unless the paths are genuinely needed.

## Approve and install

Keel reports stable change IDs beside the recommendation list. Reply with the exact IDs you approve. Approval of an audit, general encouragement, or approval of one package does not authorize another package.

When Keel installs changes, it may create `.keel/state.json` containing only installed/declined IDs, evidence fingerprints, managed paths, and before/after hashes. It does not store repository evidence, source text, conversations, secrets, or metrics.

## Second run

A later audit recognizes satisfied Keel changes and suppresses unchanged declined recommendations. It resurfaces a declined package only when relevant repository evidence materially changes. If no installation or state-only change was approved, Keel creates no state file and cannot remember decisions across fresh contexts.

## Uninstall

Ask Keel to audit its managed artifacts and propose an exact rollback set. A Keel-created file can be removed only when its current hash still equals the recorded post-install hash. Modified files become conflicts, not deletion targets. Existing files changed by Keel use Git history or a reviewable reversal diff; `.keel/state.json` is removed last.

## Examples

### Before → after

```text
Before: every task loads duplicated instructions and several historical documents.
After: one short canonical instruction surface routes to task-relevant references.
```

### Healthy repository

```text
Main takeaway

No meaningful changes required. The repository already has a small canonical
instruction surface, task-relevant context loading, and proportionate review.
```

Keel keeps deliberately rejected recommendations visible so a no-change result is understandable rather than empty.

## Safety and control planes

Audits are read-only. Installation requires exact approval, and sensitive or destructive actions require separate approval. The scanner has no network behavior and performs lexical or syntactic classification only; the skill is responsible for semantic and architectural judgment.

This repository uses GitHub for Keel's open-source distribution and collaboration. That does not mean target repositories should use GitHub, pull requests, hosted CI, branch protection, or another hosted engineering control plane. Keel evaluates that choice from the target repository's actual operating needs.

## Development and clean-clone check

Keel has no runtime or development package dependencies. From a clean clone with Node.js 22 or newer:

```bash
npm test
node skills/building-agent-harness/scripts/scan-repo.mjs --root .
```

The tests cover deterministic scanning, output limits, sensitive-path handling, zero target mutation, skill discovery contracts, state restraint, uninstall safety, and the six non-benchmark behavior scenarios. All fixtures are synthetic Keel test material.

## License

Keel is licensed under [Apache-2.0](LICENSE).
