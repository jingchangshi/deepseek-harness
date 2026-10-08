---
kind: upgrade-guide
description: Engineering profiles add adaptive task policy, capability escalation routes, and durable scheduling artifacts.
---

# Engineering Adaptive Scheduling

English | [中文](guide.zh.md)

## Change

Engineering profiles now classify Development tasks and select role stages from repository scope, acceptance criteria, risk, and deployment policy. New deployment workflow keys set file thresholds and finite escalation limits. Role configuration can select stronger routes; model routes declare their capability level. Existing deployment files are user-owned and installation does not add these settings to an existing file. A task without scheduling policy uses conservative classification and remains complex; existing task artifacts are preserved.

Role models now return an object-rooted `response` envelope with either a complete `success` output or an `escalate` request. Capability escalation uses separate deployment routes and durable `SCHEDULING.json` state. A writer diagnosis always requires a new frozen plan, including when the model recommends `REPAIR_WITHIN_PLAN`.

## Migration

1. In `<DSH_HOME>/engineering/.agent/config/workflow.yaml`, add the top-level `simpleMaxFiles`, `standardMaxFiles`, `maxCapabilityEscalations`, and `repairEscalationThreshold` settings. Defaults are 3, 12, 2, and 2.
2. In deployment `models.yaml`, set `capabilityLevel` on routes that may escalate; omitted levels default to 0. In `roles.yaml`, add qualified `escalationRoutes` and, if needed, up to two `escalationFallbackRoutes`. A stronger route must exceed the failed route's level, use an authorized provider/model, support the required reasoning effort, and pass data-class and premium policy. See [model routing](../../../software-engineering-harness/model-routing.md).
3. In the target repository's `.agent/config/project.yaml`, add `scheduling` with a class, explicit file-leaf `scopePaths`, and `acceptanceCriteria` when a task can qualify as simple. Recognized risk values are `concurrency`, `lifecycle`, `security`, `runtime`, `compiler-ir`, and `cross-module`. Compiler profiles remain complex. See the [adaptive scheduling reference](../../../software-engineering-harness/adaptive-scheduling-v2.md) for all policy fields and scope rules.
4. Restart the engineering profile. Run a bounded task and inspect `.agent/tasks/<taskId>/SCHEDULING.json`, `BASELINE.json`, and `PLAN-SCHEDULING-<workRevision>.json`. Confirm that the frozen classification matches the repository policy and that simple-task changes remain within the listed files. Keep these task artifacts; do not edit their counters or reconstruct them manually.
