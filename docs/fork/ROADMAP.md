# Fork roadmap

This document tracks the work done in this fork (`Luanipe/gemini-cli-mod`) on
top of upstream `google-gemini/gemini-cli`. It is the in-repo source of truth
for **what** we are changing and **why**; execution artifacts (labels,
milestones, issues, PRs) live on GitHub and are linked from here.

## Scope and licensing

The upstream project was forked because it is in maintenance mode (bug fixes
only). We are adding features and improvements.

Ideas are informed by `Twigpine/openclaude` (a fork of Anthropic's Claude Code),
which receives features actively. **`openclaude` is derived from proprietary
Claude Code source, so we reimplement patterns only — we never copy its code.**
Everything here is written against the Apache-2.0 upstream.

## Status legend

| Status     | Meaning                                            |
| ---------- | -------------------------------------------------- |
| `TODO`     | Planned, not started.                              |
| `OPTIONAL` | Recorded for future consideration; not scheduled.  |
| `WIP`      | In progress on a feature branch.                   |
| `REVIEW`   | Implemented, under review / validating.            |
| `DONE`     | Merged, gates green, docs updated.                 |
| `DROPPED`  | Considered and rejected (see ADRs for the reason). |

## Definition of done

A task is `DONE` only when all of the following hold:

1. New/updated tests pass (`npm run test:core:local` for the affected packages).
2. `typecheck` passes for `@google/gemini-cli-core` and `@google/gemini-cli`.
3. `lint` is clean for the touched files.
4. Generated artifacts are regenerated when settings change
   (`npx tsx ./scripts/generate-settings-schema.ts` and
   `npx tsx ./scripts/generate-settings-doc.ts`).
5. Behavior-affecting changes are covered by an eval when practical.
6. The roadmap row (status, branch, PR, evidence) is updated.

## Conventions

- **Branches:** `feat/<component>-<task>` (for example
  `feat/anti-hallucination-post-compact-reinjection`).
- **Commits:** Conventional Commits (the repository already enforces this).
- **PRs:** one PR per component where possible, targeting `main`, referencing
  the issue(s) it closes. Stacked PRs are allowed: base the follow-up branch on
  the parent branch and retarget it to `main` once the parent merges.
- **Labels:** `fork:anti-hallucination`, `fork:harness`, `fork:yolo`,
  `fork:few-shot`, `fork:dx`.

## Components

**Current focus:** YOLO / acceptances — Y-5 (session-scoped taint trust) is in
REVIEW; Y-6 (command-aware untrusted flag detection) is next. The remaining AH
items (AH-6/7/8) are optional backlog.

Status is updated as work lands. "Evidence" points to the commit/PR that
delivered the item. Per the legend, `DONE` means **merged**; implemented and
pushed but unmerged is `REVIEW`.

### DX / AI-driven development

Our development harness (OpenCode): canonical instructions plus the subagents
and commands used to review and audit our work.

| ID   | Item                                                       | Status | Issue | Branch              | PR  | Evidence    |
| ---- | ---------------------------------------------------------- | ------ | ----- | ------------------- | --- | ----------- |
| DX-1 | `AGENTS.md` + OpenCode review/audit subagents and commands | DONE   | #13   | `feat/dx-ai-driven` | #14 | `114e2bcd6` |

### Anti-hallucination

Reduce the model acting on context that is stale, was never read, or was
silently dropped from the window.

| ID   | Item                                                    | Status | Issue | Branch                                               | PR  | Evidence    |
| ---- | ------------------------------------------------------- | ------ | ----- | ---------------------------------------------------- | --- | ----------- |
| AH-1 | Read-before-edit guard (hard-fail) + invalidation hooks | DONE   | #1    | `feat/read-before-edit`                              | #12 | `8754ff17d` |
| AH-2 | Compaction circuit breaker + cooldown                   | DONE   | #2    | `feat/anti-hallucination-compaction-circuit-breaker` | #15 | `67c354349` |
| AH-3 | Post-compact re-injection of recently touched files     | DONE   | #3    | `feat/anti-hallucination-post-compact-reinjection`   | #17 | `26159036f` |
| AH-5 | Central context ledger + adapter framework              | DONE   | #18   | `feat/anti-hallucination-context-ledger`             | #23 | `06ca2102a` |
| AH-9 | Context ledger maintenance follow-ups                   | DONE   | #24   | `feat/anti-hallucination-ledger-maintenance`         | #25 | `2bb6d7596` |
| AH-4 | Compaction-safe user instruction ledger                 | DONE   | #16   | `feat/anti-hallucination-user-instruction-ledger`    | #27 | `0f5d910ab` |

AH-4's 20-request recall scenario is covered at the adapter level
(`userInstructions.test.ts`). A model-level eval is pending because the eval
suite requires a live model.

### Harness

Improve the agent loop, tool orchestration, and robustness.

| ID  | Item                                                       | Status | Issue | Branch | PR  | Evidence |
| --- | ---------------------------------------------------------- | ------ | ----- | ------ | --- | -------- |
| H-1 | Streaming tool execution (run tools as `tool_use` streams) | TODO   | #4    |        |     |          |
| H-2 | Unify the subagent loop with the main loop                 | TODO   | #5    |        |     |          |
| H-3 | Typed turn transitions + continuation/doom-loop guards     | TODO   | #6    |        |     |          |

### YOLO / acceptances

Improve the approval model and permissive modes.

| ID  | Item                                                           | Status | Issue | Branch                          | PR  | Evidence    |
| --- | -------------------------------------------------------------- | ------ | ----- | ------------------------------- | --- | ----------- |
| Y-2 | Two danger tiers (`bypass` still honors safety checks; `full`) | TODO   | #8    |                                 |     |             |
| Y-3 | LLM auto-mode classifier with circuit breaker + denial limits  | TODO   | #9    |                                 |     |             |
| Y-5 | Session-scoped taint trust for untrusted command flags         | REVIEW | #30   | `feat/yolo-taint-session-trust` | #32 | `2074b81d3` |
| Y-6 | Command-aware untrusted flag detection                         | TODO   | #31   |                                 |     |             |

### Few-shot prompting

Improve tool-calling reliability.

| ID  | Item                                                     | Status | Issue | Branch | PR  | Evidence |
| --- | -------------------------------------------------------- | ------ | ----- | ------ | --- | -------- |
| F-1 | Concrete few-shot examples in high-error tool prompts    | TODO   | #10   |        |     |          |
| F-2 | Enable `PromptConfig.initialMessages` in built-in agents | TODO   | #11   |        |     |          |

## Backlog (optional)

Recorded for future consideration. These items are **not scheduled**; they
extend the AH-3 file re-injection into a general, adapter-based context ledger.
The shared foundation is AH-5 (#18), now delivered.

| ID   | Item                                                      | Status   | Issue | Depends on |
| ---- | --------------------------------------------------------- | -------- | ----- | ---------- |
| AH-6 | Retrieval ledger adapter: grep / ripgrep / glob / search  | OPTIONAL | #19   | AH-5       |
| AH-7 | Retrieval ledger adapter: MCP tools / `read_mcp_resource` | OPTIONAL | #20   | AH-5       |
| AH-8 | Retrieval ledger adapter: webfetch / web search           | OPTIONAL | #21   | AH-5       |

AH-9 (ledger maintenance) is DONE (PR #25) and unblocked AH-4. AH-4 (ADR-0004)
also extended the adapter contract with `droppedHistory`, which AH-6/7/8 can
reuse.

## Decision records

Decisions that are hard to reverse or that need context are recorded as ADRs in
[`decisions/`](./decisions/):

- [ADR-0000](./decisions/ADR-0000-template.md) — template.
- [ADR-0001](./decisions/ADR-0001-read-before-edit-hard-fail.md) —
  read-before-edit enforcement is a hard failure.
- [ADR-0002](./decisions/ADR-0002-post-compact-reinjection.md) — post-compaction
  re-injection of recently touched files (superseded by ADR-0003).
- [ADR-0003](./decisions/ADR-0003-context-ledger.md) — context ledger with
  pluggable re-injection adapters.
- [ADR-0004](./decisions/ADR-0004-user-instruction-ledger.md) — compaction-safe
  user instruction ledger and the `droppedHistory` adapter input.
- [ADR-0007](./decisions/ADR-0007-session-taint-trust.md) — session-scoped trust
  for untrusted command flags.
