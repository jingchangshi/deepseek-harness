# Web Application Verification Profile

English | [中文](webapp-profile.zh.md)

The [webapp profile](../../.agent/profiles/webapp.yaml) defines typecheck, lint, unit, API contract, database migration, integration, E2E, build, and deployment smoke checks. A small-feature profile keeps only typecheck, unit, and build.

## Configure a Project

Map the profile names to target-owned argv commands. The same format supports Playwright, Mini Program automation, backend test runners, and database tools without adding framework logic to `agentctl`. Commands that require Linux can declare `platforms: [linux]`.

## Acceptance

The committed webapp profile requires typecheck, lint, unit, E2E, and build. Optional API, migration, integration, and deployment checks remain visible and keep their exact status. A required `NOT_RUN`, `INCOMPLETE`, or `FAIL` result prevents acceptance.

## Example

[`webapp.project.yaml`](../../tools/agent/examples/webapp.project.yaml) is a credential-free synthetic adapter used by the complete E2E test. Replace its commands in a target repository; do not treat the fixture as production evidence.

## Dev Note

None.
