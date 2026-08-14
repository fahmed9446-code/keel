# Installation Contract

## Approval gate

Approve exact change IDs before editing. Accept a subset and leave every unapproved package untouched. For a dangerous or destructive operation, obtain separate approval immediately before that operation even when its package was already approved.

Re-read the target files and `.keel/state.json`, if present, immediately before editing. Stop when the target or evidence no longer matches the approved proposal.

Each approved change package must declare all repository-relative target paths before installation. Keep one managed-artifact record per repository-relative path. If different approved change packages target the same path, refuse the later package; do not create overlapping ownership or silently merge the packages. An artifact may list multiple change IDs only when those IDs were approved and installed together as one indivisible package.

## Minimal installation

For each approved package:

1. Resolve and validate the package's complete artifact-to-change-ID mapping. Every managed artifact has a non-empty `changeIds` array, and every ID in `changeIds` must be both explicitly approved and present in `installedChangeIds` after validation succeeds.
2. For a new target, confirm the path does not exist immediately before creation. For an existing file, pass the Git preimage gate below before editing.
3. Make the smallest coherent edit.
4. Run the package-specific validation.
5. Record the resulting hash and installed IDs only after validation succeeds.
6. Report the installed ID, validation, risk, and rollback path.

Create `.keel/state.json` only after an approved installation or explicit approval to persist deferred decisions. No installation and no approved persisted decision means no state file.

### Existing-file preimage gate

Automatically edit an existing file only when the repository is a Git worktree, the path is tracked as a stage-zero regular blob, and both the index and working tree are clean for that path. Resolve the blob's object ID, re-read that blob from Git, and verify that its exact bytes equal the current bytes before editing. Record the exact-byte `preInstallHash` and the reconstructible blob ID as `preInstallGitOid` before the write.

Dirty, untracked, non-Git, unmerged, symbolic-link, submodule, missing-object, or otherwise unreconstructible existing files are refusal cases: refuse the automatic edit and explain the failed predicate. A refusal must not create or update `.keel/state.json`, mark a change ID installed, or alter any target. Human-authored manual changes remain outside Keel-managed state.

Use this complete state shape:

```json
{
  "schemaVersion": 2,
  "keelVersion": "1.0.1",
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
      "changeIds": ["context-trim-permanent-instructions"],
      "preInstallHash": "sha256:before",
      "preInstallGitOid": "0123456789abcdef0123456789abcdef01234567",
      "postInstallHash": "sha256:after"
    }
  ]
}
```

These five top-level fields are the complete schema. Keep paths repository-relative and unique. `changeIds` is required and non-empty for every artifact. `preInstallHash` is required; use `null` when `createdByKeel` is true. `preInstallGitOid` is optional and omitted for a Keel-created file, but required for every existing file Keel edits. Hash exact file bytes. Fingerprint only the normalized facts relevant to the recommendation. Keep reasons optional and short.

## State v1 compatibility and migration

State with `schemaVersion` 1 is recognized as legacy read-only state. It may inform audit restraint and conflict reporting, but do not rewrite it, append fields, install through it, or uninstall from it.

Migration is a separate exact migration change package, such as `state-migrate-v1-to-v2`, that requires its own approval. Ownership proof must be artifact-specific and independently verifiable: every path-to-change-ID association must come from evidence such as an approved install record that matches the artifact path and its recorded pre-install and post-install hashes. Cardinality is not provenance; the number of installed IDs never proves an artifact association. For every existing managed artifact, also prove its recorded pre-install bytes resolve to an exact reconstructible Git blob whose bytes match `preInstallHash`. Never infer an association or invent a Git object ID from current content.

The existing `.keel/state.json` must itself pass the existing-file preimage gate before automatic migration. If the state file is dirty, untracked, non-Git, or otherwise unreconstructible, refuse migration until a reviewable clean tracked Git preimage is established. Build and validate the complete schema-2 replacement before one atomic state-file write. If any state-file preimage, association, path ownership, artifact hash, or artifact pre-install Git blob is ambiguous or unavailable, leave the v1 state byte-for-byte untouched and report that migration needs human resolution.

## Second run

- Evaluate installed satisfaction through each artifact's `changeIds` association. If an installed change ID remains satisfied and all associated managed artifacts match, do not propose it again.
- If a declined or deferred ID has the same evidence fingerprint, do not propose it again or nag about it.
- If relevant evidence materially changed, reassess and resurface the recommendation only when the new facts justify it; explain what changed.
- If a managed artifact drifted after installation, report the drift without overwriting it.
- If an artifact association is missing or ambiguous, report the state problem; do not re-propose the associated change, overwrite the artifact, or repair state by guessing.
- Recognize Keel-managed files as installed state, not new repository sprawl.
- Do not recommend tracking or committing `.keel/state.json` solely because it is untracked. Version-control policy is a repository and human decision; recommend shared state only when explicit repository evidence requires Keel decisions to persist across clones.

## Uninstall

Request approval for the exact rollback set.

- **Keel-created file:** Only a Keel-created file whose current hash equals its recorded post-install hash may be removed automatically, and only after exact rollback approval. If the hash differs, do not delete it; report that later work exists.
- **Existing file changed by Keel:** Never reverse or delete it automatically, even when its current hash still equals the post-install hash. Reconstruct the exact preimage from `preInstallGitOid`, generate a reversal diff against the current bytes, and require explicit approval of that diff. If reconstruction or clean application is not provable, leave the file untouched.
- **Partial conflict:** Roll back only artifacts proven safe. Retain each unresolved artifact entry and its installed change-ID associations in state, while removing only entries that were safely resolved. Remove an installed change ID only after every artifact associated with it is resolved.

Retain `.keel/state.json` while any managed artifact is unresolved. Remove `.keel/state.json` only after every managed artifact is safely removed or reversed and no installed or deferred decision remains to preserve.
