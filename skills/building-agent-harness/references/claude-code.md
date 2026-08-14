# Claude Code Reference

## Detection

Run `claude --version` when available. No Claude Code executable was available in the Keel V1 development environment, so do not infer behavior from Codex or parse arbitrary help prose.

## Always-loaded instructions

Claude Code uses `CLAUDE.md` and its documented memory hierarchy for persistent project guidance. Keep repository-wide facts thin and route to canonical shared documentation.

## Scoped/lazy instructions

Claude supports nested project guidance, path-scoped rules, and explicit `@path` imports. Imports mechanically induce reading; use them only when the imported material is needed at that scope.

## Skills

Project skills live at `.claude/skills/<skill-name>/SKILL.md`; personal skills live under `~/.claude/skills`. Skill bodies load on use rather than as permanent `CLAUDE.md` content.

## Task memory

Claude documents auto memory and optional subagent memory. Keel does not enable persistent reviewer memory because it weakens freshness and creates another maintained truth.

## Filesystem/network/capability controls

Claude documents permission modes, tool allow/deny lists, plan mode, and read-only subagents. Verify the current local configuration before treating these as enforcement.

## Independent-review options

When justified, use a non-fork fresh subagent or new Claude Code session with only read-oriented tools and no persistent memory. Provide the review question and raw diff evidence, not the implementer’s verdict. The documented mechanism is useful, but isolation strength is not runtime-verified by Keel V1.

## Native install locations

- Project: `.claude/skills/building-agent-harness/`
- User: `~/.claude/skills/building-agent-harness/`

Copy the complete skill directory. Do not replace shared repository truth with a parallel Claude-only documentation set.

## Known limitations

The runtime executable was not available locally. Capability documented but not locally verified includes live skill discovery, permission enforcement, and fresh-subagent behavior. Subagents other than documented exceptions can still load `CLAUDE.md`, so “fresh” does not mean free of repository instructions.

## Installation validation

Start a new Claude Code session at the repository root. Invoke `/building-agent-harness` directly and with a matching natural-language audit request. Confirm that the audit is read-only and that installation is not attempted without exact-ID approval. If the skill directory was created after session start and is not detected, restart as documented.

## Capability baseline

- Verified documentation date: 2026-08-14
- Known compatible version/range: not established locally
- Capability documented but not locally verified: native skills, hierarchical guidance, restricted subagents, permission modes
- Verified installation mapping: `.claude/skills/building-agent-harness/` from official documentation
- Supported methodology: audit and conservative approval/install guidance
- Official sources: [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents), [memory](https://code.claude.com/docs/en/memory)
- Unavailable / uncertain: local runtime smoke behavior and enforcement details
