# Security and Data Policy

English | [中文](security-data-policy.zh.md)

Every task declares `public`, `internal`, or `sensitive`. Every route declares its maximum class and whether it uses an external relay. `assertDispatchAllowed` checks both before model dispatch.

## Sensitive Input

Sensitive input must be synthetic, anonymized, or explicitly approved. External relay routes reject sensitive input even when prepared. An explicit approval records source, route, approver, and expiry in repository evidence. All Magpie routes are external relays and reject sensitive input, including prepared sensitive input.

## Secrets

Committed model configuration contains credential environment-variable names, never values. DSH resolves credentials at request time. Project adapters use argv arrays and do not interpolate a shell command. Repository checks should scan task artifacts and adapter files for private keys, bearer tokens, and API keys before acceptance.

## Scope

This policy prevents accidental routing in project orchestration. It is not an operating-system isolation or compliance platform. Deployment owners remain responsible for provider agreements, retention settings, access controls, and approval identity.

## Dev Note

None.
