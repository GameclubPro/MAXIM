# Development And Release Reliability

## Scope

This plan addresses reproducible development and release failures, not unmeasured production
performance. It changes no moderation policy, database schema, or rollout switch. Participant
reports remain globally off until their separate live-smoke requirements are met.

## Implemented Controls

| Failure mode                                                 | Control                                                                                                                                    | Acceptance check                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Contract rebuild removes `dist` while Vite reads it          | Both Vite dev configs resolve exact public exports to existing TypeScript sources; production keeps package exports                        | Alias coverage test, frontend builds, local browser smoke during a contracts rebuild    |
| Visual tests silently reuse an unrelated server              | Default capture/audit allocate an unused local port, start their own Vite with `--strictPort`, and verify its instance header and app HTML | Occupied-port, wrong-identity, stalled-response and explicit-reuse tests                |
| Formatter changes byte-exact generated output                | `.prettierignore` excludes generator-owned output                                                                                          | Prettier file-info test and generator checks                                            |
| Generator drift is found late                                | Read-only preflight checks contracts mappings, OCR identity, deploy mapping and HTTP input signatures                                      | Preflight runs before impact verification and at the start of CI Static                 |
| Raw HTTP input is trusted because of a TypeScript annotation | AST check requires `unknown` for new/changed Nest `Query` and `Body` inputs, except supported validating primitive pipes                   | Alias/namespace, unvalidated union/object, handler-change and baseline tests            |
| Staged verification tests different worktree code            | Reject unstaged/untracked non-Markdown inputs and partially staged selected files; recheck index tree after each verification command      | Temporary-repository tests for partial staging, untracked files and mid-run index edits |
| VPS GitHub SSH port 22 is unavailable                        | Explicit per-deploy transport selection preserves remote SSH identity and host verification                                                | Transport tests cover bootstrap, identity, invalid inputs and CI ordering               |

## Daily Workflow

Native capture also reapplies its frame-only geometry after scenario navigation/reloads and checks
that the preview scaffold is absent before saving. A scenario reload must not produce a framed
emulator image labeled as a native-layout success.

1. Read the scoped notes and inspect the worktree. Keep unrelated changes separate.
2. Run `node scripts/agent/preflight.mjs` before expensive suites. It is an early error check, not
   release approval; it neither builds nor repairs generated files automatically.
3. Use focused tests while editing. Run the indicated generator if preflight reports stale
   output, then inspect the generated diff.
4. Use `node scripts/agent/plan.mjs --worktree` to determine checks, migrations and deployment
   scope. Stage only intended paths, with their tests and generated output.
5. Submit with `./infra/scripts/local-commit-push.sh "<message>" main`. Staged verification allows
   unrelated Markdown notes but refuses different executable inputs. If other runtime work must
   remain unstaged, validate and submit from a separate worktree; do not stash someone else's work.
6. Wait for both exact-SHA `Required` and `Analyze JavaScript and TypeScript`. Use the normal
   scoped deploy wrapper, then verify its strict smokes and release manifest.

Local screenshots and visual audits start an isolated owned server by default. An explicit
`MINIAPP_SCREENSHOT_BASE_URL` or `MINIAPP_VISUAL_AUDIT_BASE_URLS` keeps its requested port and
fails if that port is occupied. Reuse is deliberate: set `MINIAPP_SCREENSHOT_REUSE_SERVER=1` or
`MINIAPP_VISUAL_AUDIT_REUSE_SERVER=1`. Reuse checks the dev app HTML, but does not attest its
revision. Owned servers use a per-process identity and terminate their own process group;
unrelated servers are never stopped. Arbitrary remote/production audits remain explicitly selected.

When the VPS cannot reach GitHub on port 22, use:

```bash
MAXIM_DEPLOY_GIT_SSH_PORT=443 ./infra/scripts/vps-connect.sh deploy main --auto
```

The transport accepts only `default`, `22`, or `443`, requires a GitHub SSH origin for an override,
and uses the VPS `GIT_SSH_COMMAND`, `core.sshCommand`, or `GIT_SSH` identity in that order. It does
not print/copy keys, modify SSH/Git configuration, accept new host keys, weaken CI/SHA gates, or
retry a partially executed deployment. The wrapper carries its reviewed helper into the remote
shell, including on the first deployment to older tooling. A missing trusted host key requires
operator verification, not disabling host-key checks.

## Feature Review Checklist

- Parse HTTP input with a bounded runtime schema before property access, decoding, pagination,
  or service calls. Test missing, duplicate, array, object and oversized parameters. TypeScript
  annotations alone are not validation. The AST check is not a taint analyzer or a replacement
  for CodeQL; `unknown` still needs a real schema, not a type assertion.
- `scripts/api-http-input-baseline.json` records legacy signatures, not approved security
  exceptions. Its handler digests prevent silently changing those handlers while retaining a
  trusted input type. Migrate a changed handler to `unknown` plus validation and remove its
  exception; do not regenerate a growing baseline. Guards, headers, path parameters and custom
  request objects still need review outside this narrow check.
- Every mutation route needs its intended guard, access checks, mutation-tunnel allowlist where
  applicable, denial tests and frontend transport coverage. Do not infer admin access in the UI.
- Durable asynchronous actions need a recorded decision, execution-time guards, crash recovery,
  idempotent dispatch, truthful partial/ambiguous outcomes, and restart/race tests. Design receipt
  retention separately from temporary dispatch-ledger retention; test expiry and cleanup.
- History scans require bounded indexed keyset pages with fixed time boundaries. Review the
  migration's lock, concurrent-index, timeout and invalid-index recovery behavior on representative
  local data. During a slow production migration, use only the approved read-only audit catalog;
  do not retry deployment or issue repair SQL without establishing its state.
- Include mobile light/dark, safe-area, scroll and keyboard checks for changed UI flows. Run local
  visuals against the worktree before an explicitly selected production-origin smoke.
- New enforcement remains opt-in behind an execution-time switch. Preserve rollback source floors
  for persisted jobs and verify every shared API role when that image changes.

## Boundaries And Follow-Up

`agent:verify` avoids running agent-tool tests or CSS checks twice when their aggregate command
already includes them. Full verification also runs the browser smoke, which the root `check`
script does not include. Tests pin these aggregate-command assumptions.

No verification cache is introduced: a green result from different inputs is not reusable release
evidence. The preflight and staged checks shorten feedback and catch mismatches; the exact committed
SHA is still validated by CI after commit hooks. Ignored local configuration and other non-Git inputs
are not a hermetic snapshot. Full builds, integration suites, CodeQL and deployment smokes remain
mandatory according to impact.

Production throughput optimization should start from comparable bounded health/capacity windows,
query plans and queue metrics. This change does not raise concurrency or DB pool sizes, run broad
history scans, relax CI, or claim lower production latency without measurements.
