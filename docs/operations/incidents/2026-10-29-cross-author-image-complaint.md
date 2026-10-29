# Cross-author image complaint, 29 October 2026

## Requirement and observed scope

The complaint concerned the same advertisement being uploaded or forwarded by different
participants. The supplied example was the latest forward in the designated test chat.
The user subsequently confirmed that the suspected duplicate had been deleted manually
and explicitly requested that the existing twelve-hour comparison window remain unchanged.

The reported group's saved settings select MESSAGE, CHAT, enabled anti-duplicate and zero
allowed repeats. The runtime diagnostic returned FULL and confirmed deletion capability.
The example's original author was neither a stored administrator nor a freshly observed
administrator/owner. These observations establish eligibility at inspection time, not the
historical settings, immunity or final authority of an unavailable duplicate.

## Source and image evidence

The supplied forward uses the ordinary MAX `link.type=forward` structure: the outer body is
empty and `link.message.attachments` contains the image. Both the direct original and the
forward extract complete IMAGE content with the same source and content identities. Their
independently downloaded WebP files are byte-identical, 847 by 1280 pixels, and have the same
canonical raster hash. No standard-forward extraction defect was reproduced.

A bounded MAX history read returned the example's original and surrounding retained messages.
All 45 preceding and 27 subsequent single-image advertisements in the selected interval were
downloaded successfully and compared locally. None matched the supplied advertisement exactly
or visually. Fifteen subsequent albums contained 35 image references without its photo ID;
their pixels were not downloaded. Removed/unreturned messages, earlier albums and matching
pixels under different album photo IDs remain coverage gaps. This sample cannot establish
that the manually deleted duplicate was unique or correctly moderated.

A five-second reviewed `chat-message-window` audit covered the example's original receipt
without saturation: it was processed, with no associated delete intent. A processed receipt
alone does not prove that media comparison completed or explain a non-action.

Two other surviving exact-image pairs were observed from one non-administrator: original
publications around 04:03 UTC and repeats around 08:29 UTC. Their receipts and equal pixels
are confirmed; their per-message media decisions are unavailable. The immutable release
history records the v4 positive-history transition completing at 07:55:08 UTC, between those
publications. The old namespace cannot authorize a new comparison; the documented transition
allows a first new occurrence while history fills. These pairs are consistent with that gap,
but do not independently prove their precise decision path or attribute the original complaint.

During initial inspection the shared API was `858a31e4c0b22483c0f5ddeaca8674a82cf757e8`, image
`sha256:bc159cf79fecdf8dfcc8b96243950fc2d7774a9799482527110da80665e85403`.
The earlier v4 transition used `8986b7bbf5e8d0aa78f1c779d4b7af0d16fd82ad`, image
`sha256:4c6f136c1a156d345b030a1be586fdd7e96ba6509a27b2a6aeef53aa0dd61da5`.
This task did not replay historical effects, seed old history, change settings or post tests
in the reported group. Private messages, locators, images and corpus files remain outside Git.

## Implemented regression plan

The smallest justified change is to cover the actual forwarding shape through the existing
Redis/BullMQ/Sharp full flow, preserving the exact-image contract:

1. Exercise CHAT direct-to-forward, forward-to-direct and forward-to-forward comparisons with
   different outer participants, different image IDs and lossless encoding changes.
2. Assert the original/current outer identities, each participant's first WARN, independent
   downloads and no repeated deletion/sanction on redelivery.
3. Preserve SAME_AUTHOR separation even when both forwards name the same nested original
   sender; preserve changed images and image references appearing only inside replies.
4. Run all affected fixture cases with disposable stores, then the staged impact aggregate
   and exact-revision CI. These are test/documentation changes and require no runtime deploy.

The six added cases verify confirmed requirements, rather than a claimed fail-before runtime
fix. The manually removed cross-author publication has not been reconstructed. A future
confirmed miss needs its exact source/time and media/dispatch evidence before changing matching,
timeouts, concurrency or source guards; see the [exact-image contract](../runbooks/exact-photo-duplicate-repair.md)
and [history transition](../runbooks/message-duplicate-rollout.md).
