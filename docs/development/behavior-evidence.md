# Behavior Evidence Before Changes

Use this procedure when a change could alter product behavior, a safety boundary, persisted-state
compatibility or an external effect. The objective is to preserve confirmed requirements and fix
defects. Current code, an old test, a comment or a successful deployment alone does not establish
that behavior is intended. Formatting and documentation-only edits need no new behavioral tests.

## Establish The Expected Result

For each affected scenario, distinguish the expected result from the observed result. Record its
classification and evidence in the existing private task record, not in a second project database.

| Classification        | Required evidence                                                                                                                          | Action                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Confirmed requirement | An applicable explicit user decision, maintained product contract or documented safety/compatibility requirement whose scope still applies | Preserve it, or change it within the user's explicit requested scope; identify the verifying test         |
| Confirmed defect      | Reproducible behavior contradicts an applicable requirement, including a newly requested correction                                        | Reproduce the defect, then test the required result; preserve neighboring requirements                    |
| Unresolved behavior   | Only implementation/history exists, intent is missing, or sources conflict                                                                 | Investigate callers, scoped references, focused tests and relevant history; state the unresolved decision |

Authority and observation answer different questions:

- Current explicit user instructions establish requested intent within their stated scope. An
  approved change can supersede an older product rule; do not generalize it to other entities,
  features or destructive operations.
- Maintained contracts and scoped safety rules establish existing obligations. Verify applicability
  to the affected version, role, feature switch and persisted data. A historical incident or plan
  may describe a superseded state; its date alone does not make it a current contract.
- Code, focused tests, logs and bounded reproduction establish what happens now. Tests may encode
  a defect, miss an exception or cover only mocks. Production success proves only the observed
  scenario; it does not establish intended behavior or coverage of other scenarios.
- Relevant `git log`/`git blame` and linked decisions can explain why unusual code exists. Confirm
  that rationale still applies. Complexity or an unfamiliar workaround is not evidence of a bug.

When sources disagree, write down both claims and their evidence. Do not silently choose the
implementation, the newest document or the easiest assertion. Resolve what can be established
locally. Ask the user only when the remaining choice materially changes product semantics or
authorization and is not already answered by their instructions. Continue independent work;
elapsed time is not an answer. A working assumption must remain labeled as an assumption.

## Gather Only The Relevant Context

Before editing, select the likely files, including affected callers:

```bash
node scripts/agent/context.mjs --path apps/api/src/webhook/webhook.service.ts
```

Repeat `--path` for other files. After edits, use `--worktree` or `--staged` to discover guidance
for the actual diff, including removed paths and both sides of renames. `--json` provides the
same navigation as structured data. Explicit relative paths are relative to the repository root.

The command lists ancestor instructions, reference links and `FLAG:` locations in selected files.
Read the instructions and choose matching sections from their routing tables. It does not decide
whether behavior is correct, infer all dependencies, read every linked document or prove test
coverage. Its limits and missing files are explicit; a missing flag is not evidence of safety.
Find callers and test doubles with `rg`, then add their paths when they cross another boundary.
Use the existing impact planner for required validation and delivery scope.

## Prove Preservation And Correction Separately

Keep a short record for the affected behavior:

```text
Scenario / role / switch / persisted version:
Expected result and authoritative source:
Observed result and reproduction evidence:
Classification: requirement | defect | unresolved
Requested change and neighboring requirements to preserve:
Focused test path, case name, command and before/after result:
Missing evidence or product decision:
```

For a confirmed requirement, run the existing focused case before and after the change. If an
important scenario is uncovered, add a narrow characterization test only after establishing its
expected result. For a confirmed defect, add a regression for the intended result: it should fail
for the demonstrated defect and pass after correction. Do not snapshot the current output simply
to label it correct, or change an expectation merely to obtain a green run.

If an existing test encodes the confirmed defect, update it with the evidence for the corrected
expectation and retain adjacent valid cases. Test observable outcomes, including prohibited effects
where relevant. Use real PostgreSQL/Redis through the public wrappers for storage, ordering or race
invariants; a mock cannot prove them. Run focused cases before the final aggregate. Record missing
native coverage and inconclusive reproduction rather than converting them into passes.

For refactoring, keep the intended observable behavior fixed. For a requested product correction,
identify exactly what is allowed to change. Neither broad cleanup nor a failing test expands that
scope. When correcting a false positive, include both the wrongly rejected valid case and a case
that must still be rejected.

## MAXIM Examples And Durable Knowledge

- An earlier explicit decision to remove unnecessary UI copy remains applicable during a later
  redesign. Read the [active miniapp product decisions](miniapp-product-decisions.md) for any UI
  change, not only a task mentioning text. A generic request for better UX does not supersede
  that decision; preserve useful errors, action labels and accessibility information.
- A pending publication is not automatically a retryable defect. The
  [publishing contract](api-domain-reference.md#publishing-and-outbound-actions) preserves unknown
  SEND outcomes and version-specific retry policy. Establish the outcome and permitted continuation
  before changing retries; queue age alone is insufficient.
- A missing avatar field does not necessarily mean the avatar was removed. The
  [home presentation contract](api-domain-reference.md#home-presentation) distinguishes incomplete
  metadata from explicit absence. Cover both preservation and deliberate removal.
- A permission lookup failure does not always mean access was revoked. The
  [managed-entity contract](api-domain-reference.md#managed-entities-and-multi-bot) distinguishes
  explicit denial from ambiguous transport responses. Cover both outcomes instead of preserving
  or clearing access for every failure.

These examples point to maintained contracts; they are not a complete invariant inventory. For
webhook scheduling, handoff and recovery changes, use the existing
[change-to-regression matrix](../operations/runbooks/webhook-latency-prevention.md#minimum-regression-coverage-by-change).

After a confirmed correction or newly understood exception, update the nearest maintained reference
and its focused regression in the same change. Link the rationale from the relevant `FLAG:` comment
when useful. Replace superseded guidance; retain incident history separately. Do not copy the full
contract into root instructions or treat temporary task observations as permanent rules.

When the user explicitly corrects a recurring product choice, preserve the decision in a concise
scoped reference during that task. Record its scope, source, active/superseded status and acceptance
criteria, and link it from the scoped instructions used by future work. Do not rely on the chat
being available next month. Broad redesign/refactoring requests do not implicitly revoke earlier
specific decisions. A new explicit instruction can supersede them within its stated scope.

At handoff, report the required behavior preserved, the defect corrected, the evidence and remaining
uncertainty. Keep local checks, exact-SHA CI, deployment and production acceptance distinct. These
steps improve discovery and verification; they do not mechanically decide every product question.
