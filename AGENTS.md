# AGENTS.md — gemini-cli-mod

Operating guide for AI agents working in this repository. Read it fully before
every task. This file is harness-agnostic; the OpenCode subagents and commands
that implement the review/audit workflow live in `.opencode/`.

## What this repository is

- `gemini-cli-mod` is a fork of Google's
  [`gemini-cli`](https://github.com/google-gemini/gemini-cli) (Apache-2.0).
  Upstream is in maintenance mode (bug fixes only); this fork adds features and
  improvements.
- We develop it with **OpenCode**. `.opencode/agents/` holds the review and
  audit subagents; `.opencode/commands/` holds the workflow commands.
- Do **not** confuse this with `.gemini/`. That directory configures
  gemini-cli's own runtime (skills/commands used when running the CLI), not our
  dev harness.

## Source of truth (read before coding)

| Document                   | Purpose                                       |
| -------------------------- | --------------------------------------------- |
| `docs/fork/ROADMAP.md`     | Components, status, and the work queue        |
| GitHub issues / milestones | Acceptance criteria per task                  |
| `docs/fork/decisions/`     | Architecture decision records (ADRs)          |
| `GEMINI.md`                | Upstream build/test/architecture basics       |
| `CONTRIBUTING.md`          | Upstream contribution process and conventions |

If code, docs, and the roadmap disagree, **stop and ask**; do not silently pick
one.

## Golden rules (invariants — never violate)

1. **Licensing.** Never copy code from `Twigpine/openclaude`. It is derived from
   proprietary Anthropic Claude Code source. Reimplement patterns only; all code
   here is written against the Apache-2.0 upstream.
2. **Stay compatible with upstream.** Keep existing tests green and avoid
   breaking public behavior unless the task explicitly says so.
3. **One task per branch/PR.** Branch `feat/<component>-<task>`, Conventional
   Commits, and reference the GitHub issue. Stacked PRs are allowed: base a
   follow-up branch on the parent branch and retarget it to `main` once the
   parent merges.
4. **Meet the Definition of Done** before marking anything done.
5. **Record hard-to-reverse decisions** as an ADR in `docs/fork/decisions/`.
6. **License headers.** New source files (`.ts`, `.tsx`, `.js`) need the
   Apache-2.0 header with the current year (enforced by ESLint).
7. **No secrets.** Never commit secrets or `.env`; never log credentials.
8. **Don't hand-edit generated artifacts.** Regenerate the settings schema/docs
   with the scripts below.
9. **Divergence → ask.** If code, docs, and roadmap disagree, stop and ask.

## Definition of done

A task is done only when all of these hold:

1. New/updated tests pass (see gates).
2. `typecheck` passes for `@google/gemini-cli-core` and `@google/gemini-cli`.
3. `lint` is clean for the touched files.
4. Generated artifacts are regenerated when settings change.
5. Behavior-affecting changes are covered by an eval when practical.
6. The `docs/fork/ROADMAP.md` row (status, branch, PR, evidence) is updated.

Status values follow the roadmap legend. A task that is implemented and pushed
but not yet merged is `REVIEW`, not `DONE`.

## Commands (gates)

```bash
npm run test:core:local                              # core suite, skips env-dependent suites
npm run typecheck --workspace @google/gemini-cli-core
npm run typecheck --workspace @google/gemini-cli
npx eslint <changed files>
npx tsx ./scripts/generate-settings-schema.ts        # only when settings change (writes files)
npx tsx ./scripts/generate-settings-doc.ts           # only when settings change (writes files)
```

Notes:

- `npm run test:memory` and `npm run test:perf` are nightly-only; run them
  locally only when the change touches those areas.
- Markdown/config-only changes are validated by the pre-commit `prettier` hook;
  `eslint` only applies to JS/TS sources, so an "ignored" result is expected.
- The two `generate-*` scripts write files. Run them in your normal session, not
  from a read-only subagent (see below).

## Subagents and read-only

The `.opencode/agents/` subagents are **read-only with respect to the edit
tools**: `edit` is denied. `shell` stays available so they can inspect `git`
state and run the gates, but they must **not** modify the repository: never run
`git commit`, `git push`, or the artifact-generating scripts. If an artifact
needs regeneration, report it instead of doing it.

## Workflow

1. Read the issue and its `docs/fork/ROADMAP.md` row.
2. State a short plan, then implement with tests.
3. Run the gates and fix every failure.
4. Update the roadmap row (status, branch, PR, evidence), close the issue, open
   or refresh the PR.

## Review checklist (used by the `reviewer` subagent)

Inspect the current diff (`git diff`, `git diff --staged`) and the latest
commit. Check, in order:

1. **Golden rules** above (licensing, upstream compatibility, branch/commit
   conventions, headers, secrets, generated artifacts).
2. **Consistency** with `docs/fork/ROADMAP.md`, the issue's acceptance criteria,
   and any relevant ADR in `docs/fork/decisions/`.
3. **Tests**: new behavior is covered; assertions are meaningful; no flaky or
   environment-dependent assumptions. Docs/config-only changes may skip the full
   test run; say so explicitly.
4. **Gates**: run the applicable gates and report the results (including
   expected skips). Do not run artifact-generating scripts.
5. **Quality**: types, error handling, naming, dead code, and no stray debug
   output.

Report findings grouped as **Blocker**, **Should fix**, **Nit**, each with
`file:line` and a concrete suggestion, then a verdict: APPROVE or REQUEST
CHANGES.

## Audit checklist (used by the `auditor` subagent)

Audit the project as a whole and report findings with severity
(**Critical/High/Medium/Low**) and evidence:

1. **Licensing/porting compliance**: no code copied from `openclaude`; patterns
   reimplemented against the Apache-2.0 upstream.
2. **Consistency**: every roadmap row, GitHub issue/milestone, and code change
   agree; statuses and evidence links are current.
3. **Generated artifact drift**: `schemas/settings.schema.json` and
   `docs/reference/configuration.md` / `docs/cli/settings.md` match the settings
   source; regenerate and diff if unsure.
4. **Docs drift**: `docs/fork/*`, `AGENTS.md`, and `CONTRIBUTING.md` match the
   code.
5. **Hygiene**: dead code, stale TODOs, leftover scaffolding, and dependency
   smells.

## Security checklist (used by the `security-auditor` subagent)

Focus on the areas this fork touches; report severity
(**Critical/High/Medium/Low**), `file:line`, and remediation:

1. **Permissions/approval modes** (YOLO, bypass, plan): no unintended allows;
   the most permissive modes keep their safety checks and killswitches.
2. **Sandbox** integration: no bypass of the sandbox or path restrictions.
3. **Path handling and shell execution**: no traversal, no unvalidated command
   construction; respect `validatePathAccess`.
4. **Secrets**: nothing sensitive committed, logged, or written in plain text.
5. **New tool surfaces** (for example the read-before-edit guard): fail closed,
   and do not leak file contents or paths beyond what the model already had.
