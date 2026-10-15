# ADR-0001: Read-before-edit enforcement is a hard failure

- **Status:** accepted
- **Date:** 2026-10-15
- **Component:** anti-hallucination

## Context

The model could issue `write_file`/`edit` against content it had never read, or
that had changed on disk (by the user, a linter, or another tool) since it was
last read. Combined with context loss (tool-output masking, chat compaction),
this is a leading source of hallucinated edits: the model acts on a stale mental
model of the file.

Upstream gemini-cli tracks no notion of "this file was read". `edit` re-reads
the file and requires `old_string` to match, which mitigates some cases, but
`write_file` overwrites unconditionally, and neither tool knows whether the
model has actually seen the current content.

We wanted a defense that is both effective and honest about what the model has
seen.

## Decision

Introduce a session-scoped `FileReadStateTracker` (on `Config`) and a guard,
`enforceReadBeforeEdit`, wired into `edit` and `write_file`.

- A write to a file that **exists** is blocked unless the tracker has a fresh
  record for it.
- "Fresh" is evaluated against the **raw on-disk bytes** (SHA-256), with a
  size + mtime fast path. The raw bytes are hashed (not the text shown to the
  model) because the read pipeline normalizes CRLF, strips a BOM, and truncates
  long lines.
- Blocking is a **hard failure**: the tool returns a `ToolResult` error
  (`FILE_NOT_READ` / `FILE_STALE`) and does not write. The model must read the
  file again.
- Creating a **new** file is always allowed.

Enforcement is controlled by the `tools.requireReadBeforeEdit` setting (default
`true`) with the `GEMINI_REQUIRE_READ_BEFORE_EDIT` environment override.

Invalidation hooks keep the tracker meaningful across context loss: tool-output
masking and chat compaction mark records as `masked` so their content can be
re-injected later (see AH-3).

## Consequences

- Fewer hallucinated writes; the failure is actionable (the model is told to
  read first) and recoverable within the same turn loop.
- One extra full-file read is performed when recording a read (to hash the raw
  bytes). This is bounded and acceptable relative to the correctness benefit.
- Guarded calls are defensive: configs/tests that do not provide the tracker
  skip the check, so partial test doubles keep working.
- The `masked` flag does **not** affect the freshness decision — a file the
  model read remains editable even after its content leaves the window;
  re-injection (AH-3) handles fidelity separately.

## Alternatives considered

- **Soft warning:** prompt the model but allow the write. Rejected because it
  does not prevent the hallucinated write, only annotates it.
- **Warn only in `write_file`:** rejected because `edit` can also act on a stale
  mental model, even though it re-reads for matching.
- **Hash the text shown to the model:** rejected; normalization/truncation makes
  it impossible to compare against the on-disk file.
- **No allowlist for team-wide enforcement:** rejected; per-session opt-out via
  setting/env is needed for CI and headless flows.
