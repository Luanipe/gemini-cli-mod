# ADR-0005: `dontAsk` approval mode

- **Status:** accepted
- **Date:** 2026-10-21
- **Component:** YOLO / acceptances

## Context

Upstream approval modes (`default`, `autoEdit`, `yolo`, `plan`) describe a
permissiveness ladder: each mode decides which tool calls are auto-approved.
There is no mode that is explicitly **never interactive**. CI and headless runs
rely on the implicit rule that `ASK_USER` becomes `DENY` when
`PolicyEngineConfig.nonInteractive` is set, which depends on whether a TTY is
attached. A caller that wants "never prompt, but do not auto-approve anything"
has no explicit way to ask for it.

`dontAsk` exists in `openclaude` (ask → deny). Reimplementing it raises
questions that outlive the flag itself, because they affect how policy TOML
rules are matched and persisted.

## Decision

Add `ApprovalMode.DONT_ASK` (`'dontAsk'`) as a **decision policy, not a
permissiveness tier**.

- **Rule matching.** For mode-scoped rules, `dontAsk` behaves like `default`:
  rules scoped to `default` also apply. Rules may still opt in explicitly by
  listing `dontAsk` in `modes`.
- **Decision boundary.** After rules and safety checkers run, any remaining
  `ASK_USER` becomes `DENY`. `ALLOW` and `DENY` are unchanged, so `dontAsk`
  never auto-approves anything. The no-rule default is `DENY` as well.
- **Hierarchy.** `dontAsk` is absent from `MODES_BY_PERMISSIVENESS`. It cannot
  grant approvals (nothing prompts), so extending "always allow" grants from it
  would be meaningless.
- **Folder trust.** The CLI keeps `dontAsk` in an untrusted folder instead of
  downgrading it to `default`, because the mode is strictly more restrictive
  than `default` and must keep its no-prompt guarantee. `Config.setApprovalMode`
  accepts it for the same reason. The YOLO killswitch is unaffected.
- **Spelling.** The CLI flag and setting use `dont_ask` (matching `auto_edit`);
  the parser also accepts `dontAsk` as an alias, including in hand-edited
  settings. The enum value and TOML `modes` use `dontAsk`. The settings schema
  and generated docs expose only the canonical `dont_ask` value.

## Consequences

- CI runs get an explicit, self-documenting mode; denials are surfaced to the
  model instead of hanging on a confirmation that no one can answer.
- Projects that want specific commands to run in CI must allow them through
  policy rules; `dontAsk` alone only removes prompts.
- Mode-scoped policies do not need a `dontAsk` copy, which keeps existing TOMLs
  working. The cost is that `dontAsk` is a special case in rule matching rather
  than a plain member of the ladder.
- `dontAsk` participates in `nonInteractive` behavior (both deny prompts), but
  they are independent switches: `dontAsk` also denies prompts in a TTY.

## Alternatives considered

- **Reuse `nonInteractive` only.** It is derived from the environment and cannot
  be requested explicitly; scripts would keep depending on TTY detection.
- **Make `dontAsk` a tier between `plan` and `default`.** It would inherit the
  permissiveness semantics and imply that lower tiers' allows flow into it,
  which is the opposite of "deny instead of ask".
- **Auto-allow read-only tools.** Convenient for CI, but it blurs the guarantee
  that `dontAsk` never approves anything; allowlists belong in policies.
