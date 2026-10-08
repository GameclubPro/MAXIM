# Webhook preparation backlog, 8 October 2026

This incident remains open. All evidence windows below use UTC. A running
process, successful MAX action or discarded backlog does not establish recovery.

At 07:17 the fourteen API roles and two native auxiliaries ran API source
`d241e50a8b688bdc32380b20d40c2505413c50f1`, image
`sha256:7fd007511ab23b897e87fb015d63dd9b005df2be437f5cf4deb9c1d3022b440b`.
The clean VPS controller was `98b48dbd15a6d9c19ed466101b0cb934b27e364d`.
The current release manifest was absent; one typed deployment transition journal
remained. The separate cold-recovery journal was ABORTED. All 24 webhook queues
were unpaused and had no rollout owner. PostgreSQL and Redis were available.

Both readiness endpoints returned 503. At 07:17:37 the oldest QUEUED receipt
dated from 05:33:27, with approximately 6,250 seconds of raw and operational lag;
the oldest RECEIVED receipt dated from 06:21:28. A fixed `postgres-audit queue`
attempt reached its statement timeout and produced no complete report. Its count
must not be interpreted as zero. The sequential activity report completed and
showed enqueue selection and moderation-delete projection, without long-running
transactions in that single sample.

Bounded, image-attested preparation logs for 07:21–07:23 contained 24 timestamped
records, below the 2,000-record analysis cap. Tail coverage was not independently
verified. Two complete admission reporting intervals each lasted about 60 seconds:
1,057 and 1,090 admissions respectively, including retries and lifecycle work.
Most observed preparations took 100–1,000 ms. The six-slot limit was reached in
both intervals. Four rate-limited batch samples showed selection taking 423–627 ms,
additional admission work taking 114–587 ms, and dispatch taking 1,168–1,364 ms.
335–348 of 400 work units were preparation-blocked. These batch samples are not
a throughput denominator. No preparation, SQL pool, SQL transaction or SQL
statement timeout signal appeared in that bounded log window.

At 07:29:59 the host reported 8 vCPU, about 24 GiB RAM with 10.2 GiB available,
6.3% sampled I/O wait, 54% disk utilization and about 20.2 GiB free. Lag had grown
to 6,991 seconds. These are capacity observations, not proof that doubling
concurrency will double throughput.

## Reproduced defect and correction

Outbox dispatch replenished preparation slots for one second, then stopped
replenishing them while the next SQL selection ran. Operations carried across
polls could finish during that selection, leaving otherwise usable slots idle.
A deterministic regression holds six slots, begins an 800 ms next selection,
then releases the slots 50 ms into it. Before the correction only the original
six preparations have started while twelve independently eligible receipts wait.

The correction overlaps dispatch of freshly reloaded bounded representatives
with the next SQL selection. It must preserve one selector, bounded work,
same-chat exclusion, authoritative receipt reloads, and owned shutdown draining.
Preparation capacity is sized separately from BullMQ concurrency and MAX limits.

The enqueue SQL pool increases from 12 to 24 connections, enabling twelve
preparation slots with four per bot/work-class pair. The six-slot configuration
retains its previous two-slot share. One interactive preparation remains the
process limit. Fleet Prisma pools total 72 plus six dedicated admin read
connections; no other role pool, MAX limit or native-worker budget is raised.
The expanded admission regression also checks priority reservation, rejection
without a memory-only waiting queue, and shutdown drain.

## Acceptance

Record the exact deployed image and strict smoke outcomes. Require released
rollout fencing, healthy dependencies, fresh receipt settlement and action
evidence, no new execution failures, and at least fifteen continuous minutes
with raw/operational lag below ten seconds. A persistent older ordering fence
requires separate exact-authority review; it must not be removed merely to make
readiness green. Preserve historical action and replay evidence.
