# Gemini CLI Reference

## Detection

Run `gemini --version` when available. No Gemini CLI executable was available in the Keel V1 development environment; do not derive capabilities by parsing arbitrary help prose.

## Always-loaded instructions

Gemini CLI documents a hierarchy of `GEMINI.md` files spanning global, workspace, and just-in-time directory context.

## Scoped/lazy instructions

Just-in-time `GEMINI.md` discovery can scope guidance to accessed directories. `@file.md` imports are mechanically induced reading and should remain task-relevant.

## Skills

Use the native project location `.gemini/skills/<skill-name>/SKILL.md`. Keep this mapping explicit even where another cross-agent alias may be documented.

## Task memory

`/memory show` exposes concatenated context files. Keel does not install a separate Gemini task-memory store; repository truth and minimal Keel state remain canonical.

## Filesystem/network/capability controls

Gemini CLI documents a TOML policy engine for allow, deny, and confirmation decisions, including subagent tool names. Verify the installed version and effective policy before relying on it for safety.

## Independent-review options

Gemini documents project subagents under `.gemini/agents` and policy rules that can restrict them. When justified, prefer a fresh reviewer with a restricted tool surface and no implementation conclusion in its brief. This mechanism is documented but not locally runtime-verified, so state that limitation in the Merge Brief.

## Native install locations

- Project: `.gemini/skills/building-agent-harness/`
- User: the current officially documented Gemini user-skill location, verified at installation time

V1 fully maps the project location. Verify the user location against current documentation instead of guessing.

## Known limitations

The runtime executable was not available locally. Capability documented but not locally verified includes skill discovery, just-in-time context, subagents, and policy enforcement. Do not claim strong reviewer isolation without a runtime smoke test.

## Installation validation

Start a new Gemini CLI session at the repository root and ask it to invoke `building-agent-harness` for a repository-level audit. Confirm discovery, read-only behavior, exact-ID approval boundaries, and scanner execution. If any behavior differs from the dated baseline, lower confidence and stop before safety-sensitive installation.

## Capability baseline

- Verified documentation date: 2026-08-14
- Known compatible version/range: not established locally
- Capability documented but not locally verified: `GEMINI.md` hierarchy, native skills, project subagents, policy engine
- Verified installation mapping: `.gemini/skills/building-agent-harness/` from official documentation
- Supported methodology: audit and conservative approval/install guidance
- Official sources: [skills](https://geminicli.com/docs/cli/creating-skills/), [context](https://geminicli.com/docs/cli/gemini-md/), [subagents](https://geminicli.com/docs/core/subagents/), [policy engine](https://geminicli.com/docs/reference/policy-engine/)
- Unavailable / uncertain: local runtime smoke behavior and enforcement details
