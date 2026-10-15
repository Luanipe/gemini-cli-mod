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

| Status    | Meaning                                            |
| --------- | -------------------------------------------------- |
| `TODO`    | Planned, not started.                              |
| `WIP`     | In progress on a feature branch.                   |
| `REVIEW`  | Implemented, under review / validating.            |
| `DONE`    | Merged, gates green, docs updated.                 |
| `DROPPED` | Considered and rejected (see ADRs for the reason). |

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
  the issue(s) it closes.
- **Labels:** `fork:anti-hallucination`, `fork:harness`, `fork:yolo`,
  `fork:few-shot`, `fork:dx`.

## Components

Status is updated as work lands. "Evidence" points to the commit/PR that
delivered the item.

### DX / AI-driven development

Our development harness (OpenCode): canonical instructions plus the subagents
and commands used to review and audit our work.

| ID   | Item                                                       | Status | Issue | Branch              | PR  | Evidence |
| ---- | ---------------------------------------------------------- | ------ | ----- | ------------------- | --- | -------- |
| DX-1 | `AGENTS.md` + OpenCode review/audit subagents and commands | DONE   | #13   | `feat/dx-ai-driven` | —   | —        |

### Anti-hallucination

Reduce the model acting on context that is stale, was never read, or was
silently dropped from the window.

| ID   | Item                                                    | Status | Issue | Branch                  | PR  | Evidence    |
| ---- | ------------------------------------------------------- | ------ | ----- | ----------------------- | --- | ----------- |
| AH-1 | Read-before-edit guard (hard-fail) + invalidation hooks | DONE   | #1    | `feat/read-before-edit` | #12 | `8754ff17d` |
| AH-2 | Compaction circuit breaker + cooldown                   | TODO   | #2    |                         |     |             |
| AH-3 | Post-compact re-injection of recently touched files     | TODO   | #3    |                         |     |             |

### Harness

Improve the agent loop, tool orchestration, and robustness.

| ID  | Item                                                       | Status | Issue | Branch | PR  | Evidence |
| --- | ---------------------------------------------------------- | ------ | ----- | ------ | --- | -------- |
| H-1 | Streaming tool execution (run tools as `tool_use` streams) | TODO   | #4    |        |     |          |
| H-2 | Unify the subagent loop with the main loop                 | TODO   | #5    |        |     |          |
| H-3 | Typed turn transitions + continuation/doom-loop guards     | TODO   | #6    |        |     |          |

### YOLO / acceptances

Improve the approval model and permissive modes.

| ID  | Item                                                           | Status | Issue | Branch | PR  | Evidence |
| --- | -------------------------------------------------------------- | ------ | ----- | ------ | --- | -------- |
| Y-1 | `dontAsk` mode (ask → deny, for CI/headless)                   | TODO   | #7    |        |     |          |
| Y-2 | Two danger tiers (`bypass` still honors safety checks; `full`) | TODO   | #8    |        |     |          |
| Y-3 | LLM auto-mode classifier with circuit breaker + denial limits  | TODO   | #9    |        |     |          |

### Few-shot prompting

Improve tool-calling reliability.

| ID  | Item                                                     | Status | Issue | Branch | PR  | Evidence |
| --- | -------------------------------------------------------- | ------ | ----- | ------ | --- | -------- |
| F-1 | Concrete few-shot examples in high-error tool prompts    | TODO   | #10   |        |     |          |
| F-2 | Enable `PromptConfig.initialMessages` in built-in agents | TODO   | #11   |        |     |          |

## Decision records

Decisions that are hard to reverse or that need context are recorded as ADRs in
[`decisions/`](./decisions/):

- [ADR-0000](./decisions/ADR-0000-template.md) — template.
- [ADR-0001](./decisions/ADR-0001-read-before-edit-hard-fail.md) —
  read-before-edit enforcement is a hard failure.
