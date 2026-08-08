---
name: atlas-adopt
description: Adopt any repository into Atlas governance. Use when setting up Atlas on a new project, or re-running adoption after a toolchain change. Detects the real toolchain from the repo, generates .atlas config, a digest-pinned devcontainer, the validation workflow, CODEOWNERS, and the acceptance-test scaffold.
---

# Adopting a repository into Atlas

Atlas is project-agnostic. Everything project-specific lives in the target repo under `.atlas/`, generated from what the repository actually declares — never from what happens to be installed on the machine you are running on. That distinction is the whole point of this skill: a runtime pin read from `process.version` is not a pin, it is a snapshot of an unverified environment.

## Step 1 — Detect, never assume

Read these and record where each fact came from:

| Fact | Source, in priority order |
|---|---|
| Node version | `.nvmrc` → `.tool-versions` → `package.json:engines.node` → **stop and ask** |
| Package manager | lockfile present (`package-lock.json`→npm, `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `bun.lock*`→bun) → `packageManager` field |
| Browser tier | resolved `@playwright/test` / `puppeteer` version **from the lockfile, not the range** |
| Browser names (`{{BROWSERS}}`) | the browsers the project actually tests, as a space-separated `playwright install` arg list. Read `playwright.config.*` → the distinct `projects[].use.browserName` (`chromium` / `firefox` / `webkit`); if none is declared, default to `chromium`. This fills `{{BROWSERS}}` in the devcontainer Dockerfile — leaving it unsourced ships the literal string to `playwright install` and the image build fails. |
| Validation ladder | `package.json` scripts. Look for an existing aggregate script (`release:check`, `ci`, `verify`) — prefer the project's own canonical signal over inventing one |
| Test conventions | read two existing test files: runner, assertion style, bootstrap pattern, whether there is a shared fixture |
| Existing CI | `.github/workflows/*` — extend, do not replace |
| Existing agent guidance | `CLAUDE.md`, `AGENTS.md`, `.claude/` — **append, never clobber.** Quote the current heading list before editing |
| Repo visibility + remote | `git remote get-url origin`; ask the human for visibility if unsure |
| Design surface (`design` block) | Does the repo render a UI? If there are client components (`*.tsx`/`*.vue`/`*.svelte`) and a way to serve them, set `design.enabled:true` and source `harness`/`readyUrl` from the repo's `build`+`preview`/`start` scripts, `screens` from its top routes, `paths` from where UI lives (e.g. `src/**/*.tsx`), `functionSignal` from its e2e script (`test:e2e`). No UI → `enabled:false`. **Ask the human which screens matter** — do not guess the screen list. `browsers` reuses `{{BROWSERS}}` (default chromium). |

If a required fact has no source in the repository, stop and ask. Do not default it.

## Step 2 — Generate

From `templates/`, write into the target repo, filling every `{{TOKEN}}`:

- `.atlas/project.json` — validate against `schemas/project.schema.json`. `runtime.nodeSource` must name where the pin came from.
- `.atlas/missions/`, `.atlas/proposals/`, `.atlas/evidence/`, `.atlas/reports/`, `.atlas/retrospectives/` (with `.gitkeep`).
- `.devcontainer/Dockerfile` + `devcontainer.json` — base on `node:{{NODE_MAJOR}}-bookworm` (Node is the base, not something apt-installed onto another image's Node, which leaves the wrong Node first on PATH), then `playwright install --with-deps {{BROWSERS}}` so browsers derive from the lockfile-resolved set rather than a hand-matched base-image tag. Fill `{{BROWSERS}}` from the detected browser names (Step 1). Pin by digest once built.
- `.github/workflows/atlas-devimage.yml` — build and push the dev image to GHCR when the lockfile or Dockerfile changes; emit the digest.
- `.github/workflows/atlas-validate.yml` — run the ladder in the pinned container. **Every rung is required; a skipped rung fails the job.**
- `.github/workflows/atlas-review.yml` — the independent reviewer. Confirm its `claude_args` carry `--allowedTools 'Bash,Read,Grep,Glob'` (without them the reviewer cannot run the repo's tests) and `--json-schema`.
- `.github/workflows/atlas-design-review.yml` — **only if `design.enabled:true`.** Renders the UI, screenshots the declared screens with chromium, and has the design-director review the pixels + the e2e run; the gate is `plugin/atlas/design/gate.mjs`. Make it a **required** status check so it has teeth. Follow `skills/atlas-design-review/SKILL.md`.
- `.github/CODEOWNERS` — the human owns `.atlas/**`, `tests/acceptance/**`, `.github/**`, and manifests.
- `tests/acceptance/` + README, matching the project's detected test conventions.
- `.claude/settings.json` — deny rules, `defaultMode: plan`, telemetry on.
- `AGENTS.md` — review guidelines for a second-opinion reviewer.
- Append an `## Atlas` section to `CLAUDE.md` pointing at `.atlas/`.

Wire the acceptance tier into the project's own scripts: add a `test:acceptance` script, and add it to the aggregate signal **only** once its invariant tests are green — a red mission contract must not break the default branch.

## Step 3 — Seed the invariant registry

Grep for guarantees the code already enforces structurally (manifest validators, authorization assertions, contract tests). Each becomes an invariant with `status: enforced` and a test path. Each guarantee you can find only in prose becomes `asserted-only`. Do not invent invariants; record what exists.

## Step 4 — Hand back the human steps

You cannot configure GitHub rulesets, push a container image, or install a plugin. Print `RUNBOOK.md` §1–§5 with the project's real values substituted, and stop. Say plainly which steps remain and that Atlas is not enforcing anything until the merge gate exists.

Call out **§2a, the machine account**, explicitly and separately. `require_code_owner_review` and `require_last_push_approval` together mean no single identity can ever merge agent work — a project that completes every other step and skips this one has a merge gate that blocks the workflow it was built to enable, and it fails silently the first time an agent opens a pull request.

## Do not

- Write `.atlas/project.json` values you could not source from the repo.
- Add the acceptance tier to the release gate while it is red.
- Replace an existing CI workflow.
- Clobber `CLAUDE.md` or `AGENTS.md`.
- Claim adoption is complete before the merge gate is configured. Without it, every other control is advisory.
