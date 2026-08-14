# Codex Reference

## Detection

Run `codex --version` when practical. Compare the result with the capability baseline below; do not parse arbitrary help prose into a capability model.

## Always-loaded instructions

Codex reads `AGENTS.override.md` or `AGENTS.md` from global scope, then at most one instruction file per directory from the repository root to the working directory. Nearer files appear later. The documented combined default limit is 32 KiB.

## Scoped/lazy instructions

Use nested `AGENTS.md` or `AGENTS.override.md` only for genuinely narrower scope. Avoid making every task traverse unrelated references.

## Skills

Codex discovers `SKILL.md` packages under `.agents/skills` from the working directory through the repository root. It initially loads names and descriptions, then reads the selected skill body and references lazily.

## Task memory

Do not treat conversation history as repository truth. Keel relies only on canonical repository content and the tiny approved `.keel/state.json`; it does not install a general task-memory system.

## Filesystem/network/capability controls

Codex supports explicit sandbox and approval settings. `--sandbox read-only` is the verified V1 audit/review boundary. Network and writes remain subject to the active sandbox and approvals.

## Independent-review options

The strongest locally verified V1 procedure is a new ephemeral, read-only Codex CLI process that receives the diff, repository facts, and review question without the implementer conversation:

```bash
codex -a never exec --ephemeral --ignore-user-config --sandbox read-only -C /path/to/repository "Review the current change for correctness, security, regressions, and missing tests. Return findings first and do not modify files."
```

Codex also documents read-only custom subagents under `.codex/agents`, but Keel does not install one unless repository evidence justifies a reusable procedure. A subagent inherits the active sandbox unless explicitly constrained.

## Native install locations

- Project: `.agents/skills/building-agent-harness/`
- User: `$HOME/.agents/skills/building-agent-harness/`

Copy the complete skill directory, including `scripts`, `references`, and `agents` metadata. Prefer project installation only when the repository should share Keel with contributors.

## Known limitations

The default workspace-write sandbox protects an existing `.agents` directory, so installation from an active Codex session may need an explicit approved write or a human-performed copy. A fresh reviewer still reads repository instructions; fresh context reduces shared reasoning history but is not a security boundary against malicious repository text.

## Installation validation

Start a new Codex run at the repository root and ask it to identify `building-agent-harness`, state its trigger boundary, and run an audit read-only. Confirm that no files change and that the scanner runs by relative path from the installed skill.

## Capability baseline

- Verified documentation date: 2026-08-14
- Locally detected version: `codex-cli 0.133.0`
- Runtime-verified capability: project skill discovery, ephemeral execution, read-only sandbox, scanner + audit behavior
- Verified installation mapping: `.agents/skills/building-agent-harness/`
- Supported methodology: audit, exact approval, installation, rerun restraint, and uninstall
- Official sources: [skills](https://learn.chatgpt.com/docs/build-skills), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- Known limitation: capability-sensitive behavior must be rechecked when the installed version differs materially or is unknown
