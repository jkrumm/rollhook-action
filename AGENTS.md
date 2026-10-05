# rollhook-action — project instructions

A composite GitHub Action that builds, pushes and deploys a Docker image to a
RollHook server using GitHub OIDC — the consuming workflow needs no secret.
Loads on top of the global `~/.claude/CLAUDE.md`; only repo-specific facts that
are not derivable from the code live here.

## What it does

- Consumed by other repos as `uses: jkrumm/rollhook-action@v1`. The action has
  no runtime of its own: GitHub runs the committed bundle `dist/index.js` on
  `node24`.
- `action.yml` is the public interface — inputs (`url`, `image_name`,
  `image_tag`, `dockerfile`, `context`, `build_args`, `timeout`,
  `cloudflare_purge_hosts`, `cloudflare_api_token`) and outputs (`job_id`,
  `status`, `purged_hosts`). `action.yml` is authoritative; keep `README.md` in
  sync with it.
- Flow: request an OIDC token → exchange it for a registry credential
  (`POST /auth/token`) → `docker login` → build + push → trigger the rolling
  deploy (`POST /deploy`) → stream SSE logs until `success`/`failed` → optional
  Cloudflare cache purge.

## Layout

- `src/index.ts` — entry point: OIDC, docker, deploy polling, job summary.
- `src/cloudflare.ts` + `src/cloudflare.test.ts` — the Cloudflare purge module
  and its `node:test` suite.
- `dist/index.js` — the esbuild bundle GitHub actually executes. It is
  **committed**: a source change is not shippable until `dist/` is rebuilt.

## Validate

- `make check` runs exactly what CI runs: `npm ci`, `npm run typecheck`, `npm test`,
  `npm run build`, then `git diff --exit-code -- dist/`.
- The `dist/` freshness step is gating. A stale bundle fails the check; rebuild
  with `npm run build` and commit the result (`.github/workflows/ci.yml` does the
  same comparison).
- Tests are `node --test 'src/*.test.ts'` — TypeScript run directly via Node's
  type stripping. There is no separate lint or format step.
- Node 24 (CI) is the supported runtime.

## Deploy

- No runtime deploy. Shipping is a release.
- Pushes to `main` run `.github/workflows/release.yml` (semantic-release).
  Conventional commits drive the version; it bumps `vX.Y.Z`, rebuilds `dist/`,
  commits the bundle + `CHANGELOG.md` with `[skip ci]`, and moves the floating
  major tag (`v1`) to the new release so consumers can pin `@v1`.
- A merged change is only live for consumers once that release workflow tags it.
  `make deploy` only prints `deployed by CI on push: …` and exits 0.

## Verify & Monitor

- Health URL: none — a GitHub Action has no endpoint to probe; its self-test is
  the CI workflow, so `make verify` just prints a note and exits 0.
- Uptime Kuma monitor: `none` — there is no long-running process to monitor.
- OTel `service.name`: `none` — the action is not instrumented; failures surface
  in the consuming repo's Actions run.

## Gotchas

- **`dist/` is committed and gating.** Never edit `src/` without running
  `npm run build` and committing the bundle; CI fails on any drift.
- **`action.yml` and `README.md` drift.** The README input table currently omits
  `image_tag` and `build_args`; treat `action.yml` as the source of truth and fix
  the README when the interface changes.
- **The release needs a PAT secret.** `release.yml` checks out with a
  repository PAT (not `GITHUB_TOKEN`) so semantic-release can push past the
  branch-protection ruleset — don't "simplify" it back to the default token.
- **No local end-to-end run.** The action needs Docker, a live RollHook server
  and GitHub OIDC, so it can only be exercised from a consuming workflow.
