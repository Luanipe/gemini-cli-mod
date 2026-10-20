# ADR-0004: Compaction-safe user instruction ledger

- **Status:** accepted
- **Date:** 2026-10-20
- **Component:** anti-hallucination

## Context

Chat compaction replaces older history with an LLM-generated `<state_snapshot>`
plus a tail of the most recent turns. The snapshot is thematic: it intentionally
omits conversational filler and has no field for an ordered list of user
requests. In manual testing, a session with 20+ discrete requests produced a
summary of 8 broad themes, losing the exact order and several instructions.

ADR-0003 introduced a context ledger with pluggable adapters, but its adapter
contract only receives the **preserved** tail (`LedgerAdapterContext` exposes
`preservedHistory`). The segment being replaced is not available, so no adapter
can capture user turns that are about to be dropped. The same gap blocks the
retrieval adapters (AH-6/7/8), which need to see the dropped tool calls.

User instructions differ from file content along the axes ADR-0003 defined:

- They are **authoritative**: they are the user's own words and must not be
  presented as untrusted reference.
- They are **snapshots**: once compaction completes, the original turns cannot
  be reproduced from disk or a URL.
- They are short and low-entropy, so the default substring presence check is too
  aggressive.

## Decision

Extend the ledger input and add a dedicated adapter for user requests.

- **`droppedHistory`.** `ContextLedgerService.build` and `LedgerAdapterContext`
  gain a `droppedHistory: readonly Content[]` field: the truncated segment this
  compaction drops. The summarizer receives the untruncated original when it
  fits the model limit, so retrieval adapters must expect already-truncated tool
  output. The split path passes `historyToCompressTruncated`; the
  truncation-only path passes `[]` because truncation shortens tool output but
  does not drop user turns. The parameter defaults to `[]` so direct
  callers/tests remain source-compatible.
- **`userInstructions` adapter.** Registered with order 10, `kind: 'snapshot'`,
  `trust: 'authoritative'`, and `selfLabelsTrust: false` so the ledger adds its
  authoritative "historical record, not a new instruction" wrapper. It is
  **opt-in** (`enabled: false`), like every adapter other than `files`.
- **Collection.** Only `role: 'user'` turns made of plain text are collected, in
  chronological order and verbatim. Filtering is **per part**: a multi-part turn
  keeps only its instruction-looking parts, joined into one request. Tool
  results (`functionResponse` parts) and model turns are excluded. A part is
  excluded when it starts with a machine-generated container tag
  (`<session_context>`, `<loaded_context>`, `<project_context>`,
  `<extension_context>`, `<global_context>`, `<hook_context>`,
  `<background_output>`, `<context_ledger`, `<user_instruction_log>` or
  `<recently_referenced_files>`, after an optional `---` separator), when it
  contains `<state_snapshot` or `<scratchpad` (including a summary preceded by a
  scratchpad), or when it starts with a known synthetic prose prefix (IDE
  context, directory context, user/steering hints, background completion,
  local-executor warnings, history-hardening sentinels).
- **Rendering.** A `<user_instruction_log>` block with numbered `### Request N`
  sections, chronological. The adapter escapes its own container tag; the ledger
  escapes `<context_ledger>` centrally. No ledger content is written to disk.
- **Ordering and retention.** The adapter assigns newer requests a smaller
  negative `order` (newer is more recent, matching the files adapter). The
  service's `maxEntries` therefore keeps the **most recent** requests, while
  `serialize` reverses the entries into chronological order. The displayed
  request number is derived from `-order`, not from the rendered position, so a
  request keeps its original number when older entries are dropped. A
  content-derived key that is re-collected (retry after a failed compaction)
  reuses its original order and number.
- **Presence check.** `skipPresent: 'exact'`, because a short instruction can
  match inside unrelated preserved text and be dropped spuriously by a substring
  check.
- **Budgets.** `maxEntries` 100, `maxTokens` 12000, `maxTokensPerEntry` 2000,
  with explicit per-entry and block truncation markers.
- **Placement.** The ledger turn now follows the `<state_snapshot>` and its
  acknowledgement, and precedes the preserved tail. This applies to every
  adapter, including `files`, and moves the files block after the snapshot as
  well. The truncation-only path has no snapshot, so it keeps the existing
  "immediately after the environment context" placement.
- **Carry-forward and reset.** Instructions are snapshots; the service carries
  them in memory across compactions and bounds them per AH-9. `reset()` runs on
  session changes and now also invokes each adapter's optional `reset()`, so the
  adapter's numbering sequence and its content-key map are cleared with the
  carried entries.

## Consequences

- User requests dropped by a manual or automatic compaction remain available
  verbatim (within budget), in chronological order, and can answer "what was my
  Nth request?" even when earlier entries were pruned.
- The log is always framed as authoritative **historical reference**, never as
  new instructions, so a malicious or accidental instruction in the log cannot
  be confused with the current turn.
- The ledger now sees the dropped segment, so AH-6/7/8 can reuse the same input
  without another contract change.
- Opt-in avoids a token cost and a behavior change for users who do not want the
  log.
- Moving the ledger after the snapshot changes the position of the files block
  (previously before the summary). Nothing depends on the exact position; both
  are after the environment context and before the preserved tail, and the
  compression tests were updated.
- Numbering is session-scoped and monotonic. `reset()` clears the adapter's
  sequence and content-key map together with the carried entries, so a new
  session starts at `Request 1`.
- Snapshot keys are content-derived (SHA-256 prefix plus an occurrence index).
  If a compaction attempt fails after the ledger was built, the unchanged
  history is collected again on the next attempt and overwrites the carried
  entry instead of duplicating it, keeping its original order and number.
  Genuinely repeated instructions within one batch remain distinct; an identical
  instruction repeated in a later batch collapses onto the earlier entry.
- The log retains the user's text verbatim in memory for the session and
  re-injects it on every compaction. That text may contain secrets the user
  pasted or untrusted content copied from a browser or a file, and the
  authoritative wrapper is a framing hint, not a provenance guarantee. Nothing
  is written to disk or logged, and `reset()` clears it.
- The synthetic-content filter is a heuristic: a genuine user message that
  starts with one of the known synthetic prefixes, or contains a compaction
  summary marker, is conservatively skipped rather than risk re-injecting model
  output as authoritative text. Container tags are only checked at the start of
  a part (after an optional `---` separator), so a prompt that merely quotes a
  tag mid-sentence is kept.
- Subagent task prompts are authored by the parent model and enter the
  subagent's own history as user-role text. Within that session the log treats
  them as user instructions; they are not the human user's words, but they are
  the task the subagent was given.
- The central `maxTokensTotal` is allocated in adapter order. With the defaults
  (files 50k, userInstructions 12k, total 80k) both fit, but raising the files
  budget far enough can starve the authoritative block. Operators who raise
  `files.maxTokens` should also raise the central budget.
- The history-hardening `Please continue.` sentinel is indistinguishable from a
  genuine user prompt and may be logged. It carries no constraint, so the cost
  is cosmetic.
- `droppedHistory` defaults to `[]`; a caller that forgets to pass it gets no
  snapshot content rather than an error. Only the two compression injection
  points call the ledger, so this is contained.

## Alternatives considered

- **Track user turns at send time in a session tracker.** Would capture requests
  before compaction and avoid reading history, but duplicates chat history,
  creates a second source of truth, and still needs the same carry-forward
  semantics. Rejected.
- **Extract requests from the LLM summary.** The summary is exactly what loses
  order and exact wording; this would defeat the purpose. Rejected.
- **Reuse the `files` adapter.** Different trust, kind, presence check and
  ordering; a dedicated adapter keeps each concern explicit. Rejected.
- **Enable the log by default.** Adds tokens on every compaction and changes
  behavior without consent; the module is pre-release and the other non-files
  adapters are opt-in. Rejected.
- **Keep the ledger before the summary.** Simpler and avoids touching the files
  position, but the summary-first ordering reads better and matches the AH-4
  design. Rejected.
