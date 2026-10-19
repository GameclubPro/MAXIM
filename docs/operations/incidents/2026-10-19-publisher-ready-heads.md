# Publisher selection and bounded recovery inspection

Two independent defects were reproduced against the production source tree of
`2a1ba6e81295a9c0579d0903325b5bc2ad690fa2` on 19 October 2026.

The generic Publisher execution reader selected parents with a fresh SENDING
recipient before its page limit. The executor correctly refused these parents,
but only released their parent lease. Their old due time let them occupy the next
page again. Native regressions reproduced starvation of a ready ONCE publication
behind 25 such parents, NOW behind 10, and the temporal reader behind 64.

Both execution readers now exclude these parents before their limits, matching
the existing targeted reader and final executor fence. Verification and fallback
selection remain available. Current rights, immutable deadlines, stale-lease and
unknown-send recovery retain their existing guards. This fixes the reproduced
selection failure; it does not identify every production complaint.

Separately, an exact old-webhook cancellation preview refused with
`REDIS_OVERSIZE`. Read-only size inspection found 88 failed jobs totalling
8,158,404 bytes, with a largest hash of 106,779 bytes and no individually
oversized job. Retained errors accounted for most bytes. The inspector had
conflated an aggregate reply ceiling with the per-job ceiling.

Inspection now splits only an oversized aggregate, after checking every hash's
metadata. It keeps the 100-ID pagination, byte and time budgets, byte identities,
locked jobs and original error snapshots. Native coverage checks selected jobs
across chunk/page boundaries, unrelated jobs, individual oversize before payload
reads, 120,000 jobs and retained PostgreSQL history.

Deployment, an actual READY cancellation preview, its exact apply and fresh
production acceptance are separate gates. Never infer successful cancellation or
post delivery from these local regressions, and never replay an unknown SEND.
