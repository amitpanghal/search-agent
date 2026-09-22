## Summary

<!-- What and why, two sentences. -->

## Artifacts

- Intent/spec: <!-- link `intent/<slug>/`, or write "small change — no artifact" -->

## Checks

- [ ] `npm run typecheck`, `npm test` and `npm run gate:live-menu` pass locally
- [ ] Paid gates (`npm run eval`, `npm run probe`) ran only with an OK; the saved trace (`--out`) is named here if a result is cited
- [ ] Verified by hand where a person can observe it: a probe trace read stage by stage, or a `POST /query` response (a feature pull request carries the Tester's pass section for this, written by `/build-plan`)
- [ ] Touches a prompt, `schema.ts` or a pipeline stage? The plan step or Decisions line that approved it is linked (the **Human-gated resolver code** rule)
- [ ] Mechanical/generated PR (catalog refresh, lockfile)? Add the `skip-claude-review` label
