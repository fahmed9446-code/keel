# Control-Plane Fit

Assess the repository’s actual operating model before recommending controls:

- Solo or team ownership.
- Local-first or hosted execution.
- Release frequency and consequence.
- Existing human review and recovery paths.
- Compliance or audit obligations.
- Repeated operational failures a control would prevent.

Default to the existing local-first workflow when it is proportionate. Recommend hosted controls only when collaboration, release operations, compliance, or repeated failures create a concrete need. Choose the smallest control that addresses that need.

Keel uses GitHub for open-source distribution and collaboration. That distribution choice is not evidence that target repositories need GitHub, pull requests, hosted CI, branch protection, or any other hosted control plane.

Keep rejected hosted recommendations visible in `Don't build`. Keel may install a small local or hosted control only as an approved change package; it never builds a CI product, policy engine, or hosted service.
