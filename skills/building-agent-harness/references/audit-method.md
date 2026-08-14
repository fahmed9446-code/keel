# Audit Method

## Evidence pass

Inspect repository instructions, scoped skill locations, mechanically referenced documents, task-memory conventions, relevant Git facts, and existing review/control mechanisms. Use native read-only tools first. Use the optional scanner only when it saves context or makes evidence repeatable.

Do not read secret values. Do not infer semantic relationships from prose merely because they seem plausible.

## Optional scanner

From the skill directory, run:

```bash
node scripts/scan-repo.mjs --root /path/to/repository
```

The scanner performs lexical and syntactic classification only; make architectural and semantic classifications here in the skill. Check `registryVersion` before relying on known agent surfaces. Ordinary output is capped at 32 KiB and reports deterministic truncation explicitly.

Scanner content evidence is a Git index/blob snapshot, not current working-copy truth. Live dirty, staged, untracked, and ignored facts are path-status-only live facts; their content is not read. Use transparent native-agent live inspection when the report says it is required, and disclose the scanner's content blind spots.

Sensitive-looking paths are summarized by category and tracked status. Use `--include-sensitive-paths` only for an explicit diagnostic need, keep that output out of chat when unnecessary, and never open a possible secret to inspect its value.

## Judgment pass

For every candidate finding, ask:

1. What repository fact supports the problem?
2. Is the issue currently material or merely imaginable?
3. Does an existing repository mechanism already solve it?
4. Would the proposed permanent artifact cost more context or maintenance than it saves?
5. Is the recommendation traceable to observed inconsistency, safety, or an explicit product requirement?

Reject the finding if it cannot clear those questions. A report with zero changes is complete.

## Minimal records

Use only:

```text
Finding
  id
  problem
  evidence[]
  recommendation
  priority
  confidence

ProposedChange
  id
  action
  target
  summary
  rationale
  risk
  rollback
  requiresSeparateApproval
```

Use stable semantic kebab-case IDs. A package may contain related file edits that implement one coherent recommendation; do not inflate a package to evade the five-package limit.
