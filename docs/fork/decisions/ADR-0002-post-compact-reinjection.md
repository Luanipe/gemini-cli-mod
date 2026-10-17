# ADR-0002: Post-compaction re-injection of recently touched files

- **Status:** accepted
- **Date:** 2026-10-17
- **Component:** anti-hallucination

## Context

Chat compaction replaces older history with an LLM-generated `<state_snapshot>`
plus a small tail of the most recent turns. Nothing in that summary re-reads the
files the agent was working on, so after a compaction the model can be reasoning
about file content it can no longer see — a leading source of hallucinated
edits. ADR-0001 already tracks which files the model has read and marks their
records as `masked` when their content leaves the window, but it deliberately
does not restore the content.

AH-2 added a compaction circuit breaker; that only controls failure/cooldown and
does not address fidelity of the files the model was editing.

## Decision

On a successful compaction we re-inject the verbatim content of the most
recently touched files, re-read from disk:

- `FileReadStateTracker.recentlyTouched(N)` supplies the candidates, most
  recently touched first.
- Content is re-read from disk at compaction time (never taken from the summary)
  and injected in a `<recently_referenced_files>` user turn, placed immediately
  after the environment context and before the preserved tail.
- Files whose content is still verbatim in the preserved tail are skipped, so
  only content that was actually dropped is re-injected. Tool-output masking
  removes the verbatim content from the tail, which is exactly what makes a
  masked file eligible for re-injection.
- Budgets are enforced per file and in total, with an explicit truncation
  marker. They are user-configurable via `context.recentFileReinjection`
  (`enabled`, `maxFiles`, `maxTokensPerFile`, `maxTokensTotal`).
- The block is built inside `ChatCompressionService.compress`, so it is part of
  the returned `newHistory` and is included in the reported `newTokenCount` for
  both `COMPRESSED` and `CONTENT_TRUNCATED`.

## Consequences

- After compaction the model retains the current on-disk content of the files it
  was working on, reducing edits based on a summary alone.
- Re-injection costs tokens right after a compaction, bounded by
  `maxTokensTotal` (default 50k). Because the block is counted in
  `newTokenCount`, the reported post-compaction size stays honest.
- The "already present" check is a heuristic: it matches the current file
  content against the preserved tail after normalizing line endings. Files read
  only partially, or with line-ending differences the model saw normalized, may
  be re-injected even though some content survived; over-inclusion is safe.
- Re-injection is best-effort: missing/unreadable files are skipped silently
  (recorded in the result for tests/telemetry) rather than failing compression.

## Alternatives considered

- **Inject in `client.ts` after `tryCompressChat`:** simpler, but the injected
  tokens would not be counted in the compression token estimate and could push
  the context back over the limit immediately. Rejected.
- **Re-inject from the summary instead of disk:** would reproduce stale content,
  defeating the purpose. Rejected.
- **Re-inject every tracked file:** unbounded context growth. Rejected in favor
  of recency ordering plus per-file/total budgets.
- **Re-inject immediately after tool-output masking:** masking is a lightweight,
  frequent intervention; re-reading every masked file each time would add cost
  without a clear benefit. Compaction is the point at which the model's history
  is actually rewritten, so re-injection is tied to it.
