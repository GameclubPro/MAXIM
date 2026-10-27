# Support answer quality

Improve support in this order: contextual routing, reviewed facts and retrieval, grounded
procedures, concise language, then measured CPU latency. A knowledge or prompt update does not
fine-tune model weights. Fine-tuning is reserved for persistent errors after these changes and
requires separately reviewed examples and an unused evaluation set.

## Response contract

Answer the current question first, then give an available next step. Ask one useful question only
when its answer changes that step. Usually use two to four short sentences; a procedure needs its
actual ordered steps. Preserve the required conditions and exact UI labels. Do not add unrelated
FAQ, repeat completed checks or ask again for unavailable screens.

Use respectful Russian with «вы». Understand colloquial language, typos and irritation without
copying insults or giving lectures. The name «Майор Максимов» does not imply military roleplay.
One short acknowledgement of a difficulty can help; repeating it in every answer cannot replace
the solution. Keep the application-managed AI signature once in its own paragraph.

Use the public project name «Майор Максимов»; MAX is the messenger. Internal repository and
runtime names do not belong in customer prose. The shared presentation boundary normalizes
the public name and separates dense prose, inline numbered steps and long list items while
preserving words, quoted controls, URLs, times and numeric limits. A full bot directory uses
eight item lines grouped by role, with one verified profile link per bot. Check the body before
the signature: a blank line that only separates the signature does not prove readable layout.

The latest explicitly stated role is contextual information. An unknown role is distinct from
a participant. Advertisements in another group go to that group's administrators; questions
about the bot receive product help. The assistant has no account tools and cannot confirm live
settings, current prices, a person's identity or the cause of an individual deletion.

Suggested editorial examples, to verify against the current UI before using for training:

| Situation                                               | Useful response shape                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Text exceeds a verified editor limit                    | Name that limit first; suggest shortening or splitting the post.                            |
| A completed setting did not resolve the problem         | Continue from the completed check; ask for the one missing observation.                     |
| The user cannot see Events                              | Offer a next step using available information; do not require that same screen again.       |
| A participant wants to place an advertisement           | Direct them to the administrators of that particular group and explain this chat's purpose. |
| An administrator asks the assistant to change a setting | Explain that the assistant cannot perform it, then give the verified path.                  |
| A send result is unknown                                | Check the existing result before trying again; do not recommend blind resubmission.         |

## Facts and regression

Keep instructions atomic by task, with their product, audience, checked UI names, prerequisites,
limitations and sources. Separate mass-setting operation results from audience statistics, text
filters from AI controls, native MAX features from Publisher, and platform support from project
support. Customer facts must not contain internal imperatives, source metadata or invalid example
links. A source ID in generated JSON does not prove every sentence is supported.

Application-authored answer requirements may highlight conditions in retained facts. Keep them
separate from the facts and untrusted question/history; rebuild them after context trimming.
Scope reminders to the current task, not every retrieved prerequisite. Keep allow/block/inspect
link goals separate, and describe all three modes neutrally in the shared fact. A URL requested
for an answer is not itself a link-filter task. An unknown publication result needs its existing
card and recipient/send evidence; it must not acquire a new-post procedure from a related fact.
General connection instructions use conditional administrator rights. Already requested Lastik
connection needs the waiting/activation conditions, not repeated onboarding. A post-creation answer
mentions separate Publisher connection conditionally, without assuming the recipient is missing.
Connection intent describes user reports, not verified live status. Waiting, expired/cancelled
requests and initial setup require different next steps. Keep explicit reading/deletion rights
and successful rights confirmation in Lastik's activation condition.
An atomic Lastik waiting question uses the reviewed `lastik-connect.waitingAnswer`, preserving
both bot and requesting administrator checks and the one-hour window from the connection request.
Only an unmixed waiting task with no other functional or incident facts takes that shortcut;
setup, recovery and additional questions retain grounded inference.
Forwarding questions for a moderator retain the connection prerequisites. An offered community
link is not a link-filter task; a reported ready connection is not an onboarding request.
Named reserve comparisons retain catalog roles and the selection procedure. An incident handoff
must also answer an explicit AI observation-mode question, including when its subject is in history.
An unknown delivery label keeps verification of the existing publication ahead of connection
facts. Link-mode reminders preserve the reported mode and distinguish the desired result from
a proposed way to achieve it.

Focused tests cover eligibility and required replies together, role changes, contextual topic
retrieval, API paths, mandatory policy retention, source/link validation, honest AI identity and
intent-specific FAQ. The installer must include every imported runtime module in its immutable
manifest. Keep the bridge's per-user history and uncertain-send fences intact.

Before changing the candidate, record the previous source identity and results. Freeze candidate
bytes before the final CPU run. Retain each first result, rejected draft, error and timing; label
development reruns separately. Count neural calls, direct replies and pre-model skips separately.
Record delivery origin independently: a reviewed replacement after a rejected model draft still
incurred inference and retains that raw failure. Judge the delivered text and rejected draft
separately; a useful replacement cannot erase the model's error.
Review content against checked facts; expected text matching alone is insufficient. Keep
substantive errors and disputed expectations independently crosschecked.

Evaluate the existing regression set and a separately sealed set of new formulations. Examples
used for tuning are not independent test evidence. AI reviews must be labelled as such; they are
not human approval. Compare paired cases rather than inferring that a user's tone causes errors
from uneven topic/style counts. No generated test messages belong in a live user group.

For the new set, mark in advance every request needing product help. Use that same denominator
for accepted replies and replies rated pass; skips and rejected answers count against both.
Suggested future targets are at least 99% accepted replies and 90% pass, with all known critical
regressions closed separately. These are targets, not a declaration that a release has met them.
Report delivered-text quality and appropriate silence on ordinary conversation separately.

Measure tokenizer/context processing, decoding, actual cache reuse and full local response time.
Sequential CPU evaluation does not establish multi-user queue capacity or delivery latency in MAX.
After exact-source CI and immutable bundle refresh, use the read-only pilot preview and one
identity/availability readback; a connected worker does not prove semantic acceptance.
