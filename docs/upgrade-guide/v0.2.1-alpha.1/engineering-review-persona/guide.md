---
kind: upgrade-guide
description: "Review-only dispatch now requires a separate persona file for each read-only role."
---

# Review-only persona configuration

English | [中文](guide.zh.md)

## Change

Review-only now uses `reviewPersonaFile` for each dispatched read-only role. Existing deployments that configure only `personaFile` receive a diagnostic before provider dispatch when a Review-only task selects that role. Development continues to use `personaFile`.

## Migration

1. In the deployment-owned `.agent/config/roles.yaml`, add `reviewPersonaFile: .agent/roles/review-only.md` to each read-only role that Review-only can select: `architect`, `scout-primary`, `scout-secondary`, `challenger`, and `reviewer`. Keep each role's existing `personaFile` unchanged.
2. Ensure `.agent/roles/review-only.md` exists under the deployment root. The shared persona is available at the same path in the DSH checkout; copy it into the deployment if installation did not initialize it.
3. Run a Review-only task. Confirm it dispatches with the review persona; a missing key or file is reported before provider dispatch.
