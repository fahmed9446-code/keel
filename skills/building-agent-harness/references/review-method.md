# Independent Technical Review

Ask:

> Is the same AI reasoning context both implementing substantial work and certifying its own correctness, without another meaningful technical review layer?

Treat the answer as material only when repository risk supports it: destructive data handling, security boundaries, migrations, public APIs, financial behavior, or similarly consequential changes. Existing meaningful human review normally means **Don't build** for redundant AI review.

## Lightweight procedure

When the human approves review independence:

1. Select the strongest fresh and restricted mechanism verified for the active agent.
2. Give the reviewer the task, diff/base, relevant invariants, and test evidence. Omit the implementer’s conclusion.
3. Require findings first, with file evidence and severity; style-only observations do not block.
4. Keep the reviewer read-only and on-demand.
5. Return a Keel Merge Brief.

## Keel Merge Brief

```text
Scope reviewed
Evidence inspected
Findings by severity
Tests and checks considered
Limitations of independence or tooling
Merge recommendation and unresolved decisions
```

Do not create a service, database, orchestration layer, scoring system, CI reviewer, or persistent archive. Install at most one small repository procedure or agent-native reviewer definition when repeated use justifies its maintenance.
