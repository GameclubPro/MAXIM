# Publisher retry diagnostics amplified Redis work

On runtime `b2062a302fd0fedb134ed744c5e171ffa9a532e8`, the bounded Redis slowlog
sample observed at `2026-10-15T21:24:01.002Z` contained 29 entries after the
`21:04:40Z` deployment boundary. All were BullMQ operations for
`publisher-suggestion-admin`: 16 `moveToDelayed`, ten `moveToActive` and three
`moveToFinished`. The largest measured operation took 31,962 microseconds;
the largest serialized argument was 2,062,249 bytes. The 64-entry slowlog
sample was saturated and thresholded, so these are neither all operations nor
a measured fleet latency distribution.

A separate bounded read at `21:26:15.344Z` selected three exact jobs from that
sample. Each was a `deliver` job with 190 bytes of data, 217 bytes of options,
2,062,102 bytes of stack history, eight configured attempts and no configured
stack-history limit. No message content, job identities or stack text was
exported. This identifies oversized diagnostic history in those three jobs;
it does not establish their remote delivery outcome or all sources of Redis lag.

BullMQ retains stack history when the existing recovery path rearms a failed
job and resets its attempt counters. The Publisher suggestion processor now
applies `stackTraceLimit: 16` to each loaded job before its guards. This also
covers retained jobs whose persisted options predate the change. BullMQ bounds
the diagnostic history on its next ordinary failure write. The change does not
enumerate or remove jobs, grant retry authority, change retry schedules, or
alter the durable SQL delivery receipts and ambiguity fences. Other queues,
including MAX action jobs whose retained failure text has separate semantics,
keep their existing behavior.

Real Redis/BullMQ regressions seed more than 2 MB of synthetic historical
diagnostics, exercise guard and delivery failures, and verify a resulting
stack below 16 KiB, the retained latest failure, unchanged job data and attempt
budget, and normal continuation of that same job. The focused five-suite run
passed 39 tests. A separate native run with `--detectOpenHandles` passed both
new cases without an open-handle report. The initial combined run emitted a
worker-exit warning; the isolated native check does not establish that every
other suite is leak-free.

This is a count limit, not a hard bound on a single error's size. Existing history
is read once before a subsequent failure can shrink it; successful or explicitly
delayed jobs do not receive a fabricated failure merely for cleanup. Runtime
deployment and post-release measurements are still required. This correction
does not resolve the separate historical webhook ordering blockers or start
the final acceptance window.
