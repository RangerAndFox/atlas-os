---
name: atlas-design-review
description: Render a UI-bearing change in CI, screenshot the declared screens with chromium, and have the design-director review the actual pixels plus the repo's own end-to-end run. Emits a verdict the design gate enforces. Use on user-facing PRs. The director can block; the owner can override.
---

# Atlas design review — look at the product, not the diff

A design advocate that reads only the diff is theater. This skill makes the review look at
**rendered pixels** and **real behavior**, in any repo, with no dependence on a hosted
preview URL (many Atlas repos deploy on Railway/Docker with no Vercel preview).

## The mechanism (same in every repo)

```
checkout → install → bring the UI up headless via the repo's declared harness
        → poll readyUrl until 200
        → Playwright + chromium visits each declared screen at each viewport, saves PNGs
        → run the repo's own e2e (functionSignal) and record its real exit code
        → design-director role reviews the PNGs + diff + e2e result → structured verdict
        → evaluateDesignGate(...) turns that into a merge decision (blocks / pass / skip)
```

The captured PNGs are the **evidence**. The gate (`plugin/atlas/design/gate.mjs`) refuses a
GO that produced no screenshots — a design pass that looked at no image looked at nothing.

## Per-repo config (`.atlas/project.json` → `design`)

Human-written (agents cannot write `project.json`). See the schema for the full shape:

- `enabled` — false for repos with no UI. A disabled/scoped-out run is a **logged skip,
  never a green pass**.
- `harness` + `readyUrl` — how to bring the UI up, and the URL polled until it answers 200.
- `screens[]` (`{name, path}`) and `viewports[]` — WHAT to capture. The human declares what
  matters; the director reviews exactly those and flags anything changed-but-undeclared.
- `paths[]` — the globs that make a PR "user-facing". A PR touching them makes the design
  check **required**; a PR touching none skips (logged, not passed).
- `functionSignal` — the repo's own e2e command. Its real exit code is the works-as-intended
  signal; a failure is a NO-GO on its own.

## The gate is the enforcement (not the model, not trust)

`plugin/atlas/design/gate.mjs` `evaluateDesignGate(...)` is pure and unit-tested
(`tests/acceptance/design-director/`). The CI workflow calls it and exits non-zero on
`blocks`, so the tested logic **is** the enforced logic. Fail-closed: missing evidence, a
dead harness, a failing e2e, or an absent verdict all resolve to BLOCK.

## Teeth + override

On a user-facing PR a NO-GO blocks the merge. The owner — and only the owner, verified by
the labeling actor — may override with the label `atlas-override-design`. The machine
account cannot self-clear. Override bypasses the design check only; code-owner review on
guarded paths still stands. An override is not recorded as a design pass.

## Invariants (proven by tests, not by trust)

`node --test tests/acceptance/design-director/design-director.test.mjs` proves:

- No screenshots ⇒ no GO; a missing declared screen ⇒ block (AC-D1).
- Harness fail / UI never up ⇒ forced NO-GO (AC-D2).
- NO-GO on a user-facing PR blocks; a healthy GO does not false-block (AC-D3).
- `atlas-override-design` honored only for the owner; override is not a pass (AC-D4).
- A scoped skip never records a pass (AC-D5).
- The role holds no merge/promote/label/project-write verb (AC-D6, via the supervisor
  authority allowlist).
- A failing `functionSignal` blocks even on a GO; a missing one is not fabricated into a
  pass (AC-D7).

## Do not

- Do not approve a screen you did not receive a screenshot of. Say it wasn't rendered.
- Do not treat a green e2e summary as truth without its exit code.
- Do not give the design-director an interface with a merge/promote/label method — the
  authority allowlist will refuse it, by design.
