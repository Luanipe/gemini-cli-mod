# ADR-0007: Session-scoped trust for untrusted command flags

- **Status:** accepted
- **Date:** 2026-10-25
- **Component:** YOLO / acceptances

## Context

Shell commands whose arguments were sourced from `<untrusted_context>` are
flagged by `findUntrustedFlags()` and forced through a confirmation, even in
YOLO mode. The detector is intentionally conservative, but it is also
command-agnostic: benign flags such as `rg --type`, `rg --hidden`, `rg -e`, and
ordinary path arguments can trigger the warning, and the same command prompts
again on every invocation.

Users need a way to accept a command once per session without writing an "Always
Allow" policy rule to TOML. The trust must be at least as narrow as the session:
a new session must ask again.

## Decision

Add **session-scoped taint trust**, keyed by root command.

- The first untrusted-flag event for a root command in a session prompts.
- Trust is keyed by the **effective command**, not the outer wrapper: `sudo rg`
  trusts `rg`, not `sudo`; `timeout 5 rg` trusts `rg`. Wrapper commands
  contribute to the execution-flag guard but never widen what is trusted.
- The confirmation offers `Allow <command> for this session`. Selecting it
  records the effective command in an in-memory `WeakMap` keyed by the `Config`
  instance. No policy rule is published and nothing is written to TOML.
- Later invocations of the same root command skip the taint confirmation, but
  the tool output ends with a short warning listing the flags that were allowed
  by session trust.
- Trust scope depends on the approval mode:
  - **YOLO** trusts all flags of the trusted command.
  - **default / autoEdit** trust ordinary flags but keep guarding
    command-specific execution flags (`rg --pre`, `git -c`, `find -exec`,
    `node -e`, `bash -c`, `python -c`, and similar). Those re-prompt even after
    the command is trusted.
- Build-file protection is **not** covered by taint trust. A modified build file
  still forces its existing confirmation.
- `disableAlwaysAllow` disables taint trust as well.
- The store is cleared by `Config.setSessionId()`, which covers `/clear`,
  resume, and new session IDs. `Config.rotateSessionId()` intentionally
  preserves trust because it is used for model-fallback retries within the same
  session. A new process starts with an empty store.
- The new confirmation outcome is `ProceedAlwaysTaint`, which `updatePolicy()`
  handles before the generic policy-update path.

## Consequences

- Repeated benign prompts for the same command disappear after the first
  approval, without persisting a broad allow rule.
- In YOLO, trusting a command like `git` also trusts its execution flags for the
  session. That is the explicit trade-off of "at least one prompt per session";
  other modes keep the execution-flag guard.
- The trust store is process-local. Subagents that share the `Config` instance
  share the session trust, but it cannot leak across sessions.
- False positives in the detector still produce a misleading first warning until
  command-aware detection (Y-6) lands. Session trust makes that a one-time cost.
- The warning remains visible in the command output, so the user is not left
  unaware that tainted flags ran.

## Alternatives considered

- **Per-flag trust.** Safer but noisy: a command with many flags would require
  many approvals, and new flags would prompt again.
- **Persistent "Always Allow" for the command.** Rejected: too broad for data
  sourced from untrusted context and it would make the decision outlive the
  session.
- **A `taintPolicy=warn` mode that never prompts.** Rejected for this task: the
  requirement is at least one decision per session. A non-interactive
  `on_prompt=deny` still denies instead of silently allowing.
- **Disable taint detection entirely.** Rejected: the detector protects against
  real prompt-injection vectors such as `rg --pre`, `git -c`, and `find -exec`.

## References

- Issues: #30 (Y-5), #31 (Y-6)
- Roadmap: `docs/fork/ROADMAP.md` (YOLO / acceptances)
