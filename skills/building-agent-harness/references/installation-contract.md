# Installation Contract

## Approval gate

Approve exact change IDs before editing. Accept a subset and leave every unapproved package untouched. For a dangerous or destructive operation, obtain separate approval immediately before that operation even when its package was already approved.

Re-read the target files and `.keel/state.json`, if present, immediately before editing. Stop when the target or evidence no longer matches the approved proposal.

## Minimal installation

For each approved package:

1. Record the current hash of every existing target.
2. Make the smallest coherent edit.
3. Run the package-specific validation.
4. Record the resulting hash only after validation succeeds.
5. Report the installed ID, validation, risk, and rollback path.

Create `.keel/state.json` only after an approved installation or explicit approval to persist deferred decisions. No installation and no approved persisted decision means no state file.

Use this complete state shape:

```json
{
  "schemaVersion": 1,
  "keelVersion": "1.0.0",
  "installedChangeIds": ["context-trim-permanent-instructions"],
  "declinedOrDeferredChangeIds": [
    {
      "id": "review-add-independent-check",
      "evidenceFingerprint": "sha256:example",
      "reason": "Existing human review is sufficient"
    }
  ],
  "managedArtifacts": [
    {
      "path": "AGENTS.md",
      "createdByKeel": false,
      "preInstallHash": "sha256:before",
      "postInstallHash": "sha256:after"
    }
  ]
}
```

Keep paths repository-relative. Fingerprint only the normalized facts relevant to the recommendation. Keep reasons optional and short.

## Second run

- If an installed change ID remains satisfied and its managed artifacts match, do not propose it again.
- If a declined or deferred ID has the same evidence fingerprint, do not propose it again or nag about it.
- If relevant evidence materially changed, reassess and resurface the recommendation only when the new facts justify it; explain what changed.
- If a managed artifact drifted after installation, report the drift without overwriting it.
- Recognize Keel-managed files as installed state, not new repository sprawl.
- Do not recommend tracking or committing `.keel/state.json` solely because it is untracked. Version-control policy is a repository and human decision; recommend shared state only when explicit repository evidence requires Keel decisions to persist across clones.

## Uninstall

Request approval for the exact rollback set.

- **Keel-created file:** If its current hash equals the recorded post-install hash, propose removal. If the hash differs, do not delete it; report that later work exists.
- **Existing file changed by Keel:** Do not restore the old bytes blindly. Prefer Git history or generate a reversal diff for review and explicit approval.
- **Partial conflict:** Roll back only artifacts proven safe and retain the remaining state entries.

Remove `.keel/state.json` last, after every managed artifact is either safely reversed or deliberately retained with its conflict explained.
