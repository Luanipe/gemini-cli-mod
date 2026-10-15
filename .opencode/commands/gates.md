---
description: Run the Definition-of-Done gates
---

Run the gates from `AGENTS.md` and summarize the results:

```bash
npm run test:core:local
npm run typecheck --workspace @google/gemini-cli-core
npm run typecheck --workspace @google/gemini-cli
npx eslint <changed files>
```

Regenerate the settings schema/docs only if settings changed. Report failures
and fix them if straightforward; otherwise explain what is wrong. Note any
expected skips (the two environment-dependent core suites).
