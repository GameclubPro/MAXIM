# Channel Post Buttons: Diagnosis and Resolution

## Scope and Evidence

The reported channel has both Major and Publik as administrators. Enabling comments
in both produces duplicate comment entries. Direct posts do not get the same actions
as posts composed in Publik.

The channel ID, example message IDs, button destinations, and saved settings were
not supplied. The findings below are reproduced from the repository and regression
tests, not a claim to have inspected or reconfigured that customer's channel.

## Root Causes

1. Comment presentation identity included the dialog profile. Major and Publisher
   links therefore survived the keyboard merge as two different buttons even when
   they represented the same visible channel action. The old tests explicitly
   required that behavior. The shared message edit lock prevented lost updates,
   but did not prevent this semantic duplicate.
2. `PublisherDialogContextService.prepare` includes the channel's configured CTA
   through `ChannelPostSignatureService.buildPostButton`. The direct-post worker,
   `PublisherChannelCommentDeliveryService`, previously constructed only comments
   and suggestions. It did not load the configured CTA at all.
3. Publication-specific `customButtons` are not channel defaults. A Reviews link
   supplied in the publication composer belongs to that publication. A direct
   message webhook contains no instruction to inherit it from an earlier post.
   Treating the last post's buttons as defaults would copy potentially unrelated
   advertising, payment, or contact destinations into future posts.

The missing Reviews link can be cause 2 or cause 3. Its exact origin must be checked
before promising a specific three-button setup. Button labels alone cannot identify
their purpose or destination.

## Implemented Resolution

### One Visible Dialog Entry

- Presentation identity is `(channel, action)` for both comments and suggestions.
  Authorization identity remains `(channel, action, profile)`.
- During a merge, the already installed dialog link wins. Neither bot replaces it
  with its own token or adopts the other profile's thread.
- Later count refreshes from the other profile cannot restore a duplicate or
  overwrite the visible discussion's counter.
- Strict attachment preservation allows comment aliases to collapse only if an
  unchanged source comment button survives. Replacing an existing discussion with
  a newly generated token is still rejected.
- Ordinary custom links are not identified by label. Same-label external buttons,
  other channels' actions, callbacks, text, and media keep their existing protection.

This is first-installed-link ownership, not a preference for Major or Publisher.
It avoids silently moving readers away from an existing discussion. It does not
merge comment databases or migrate historical threads.

### Direct-Post CTA Parity

- The Publisher direct-post worker uses the same configured channel CTA service as
  ordinary Publisher publication. No new settings or database migration is needed.
- Existing comments and suggestion links keep their original labels and targets;
  the missing configured CTA is placed after them.
- The locked source snapshot is checked before adding actions. A repeated delivery
  with all required actions already installed does not issue another edit.
- Publisher audit references include the CTA but do not claim a Major comment
  thread or schedule a Publisher count reference for it.
- Runtime readiness, exact Publisher route, channel edit permission, publication
  policy/settings revisions, and the prepared CTA are checked before mutation.
- When the direct-post CTA needs a channel-link lookup, the Publisher worker
  supplies its exact bot ID; that fallback does not depend on a Major send route.
  Publication preparation in other API roles keeps its existing lookup behavior;
  those processes must not attempt to use the Publisher bot token.

## Acceptance Coverage

Regression tests cover both bot arrival orders, repeated decoration, both profiles'
count refreshes, original thread retention, profile-isolated audit references,
comments/suggestions toggle combinations, configured/disabled CTA, CTA changes
before dispatch, exact Publisher link lookup, media/text preservation, unrelated
links, and rejection of source-discussion replacement.

The three-action fixture uses an existing Comments link, an existing
Ask-a-question-or-buy suggestion entry, and Reviews as the configured channel CTA.
A separate composer test covers Comments plus a configured contact CTA plus a
publication-specific Reviews link. These are different configurations; the latter
does not make Reviews a persistent default for direct posts.

## Customer Configuration and Historical Posts

Before closing the individual complaint, obtain the channel link/ID, one direct
post and one Publik-created post, and the intended contact/Reviews destinations.
Determine whether the second action is a suggestion dialog or an ordinary contact
link, and whether Reviews is the saved channel CTA or a per-publication link.

- If Reviews is the configured CTA, the direct-post fix supplies it automatically
  when the Publisher channel dialog processing is enabled.
- If contact and Reviews are both independent external links and only one is the
  configured CTA, exact parity needs a separately configured persistent channel
  button set. The current model has one CTA, not an arbitrary default button list.
  Do not silently promote a publication-specific URL into a shared default.
- Persisted channel defaults, if required, should use validated links, Publisher
  authorization, optimistic settings revisions, the existing shared action-row
  builder, direct-webhook admission, publication preparation, and matching preview.
  A schema/UI expansion should follow confirmation of the intended destinations.
- Do not bulk-rewrite historical posts or hide historical discussions without
  explicit message scope and a choice of the discussion to retain.

## Validation and Release

Run `npm run check:api`, `npm run check:static`, `npm run check:docs`, and
`git diff --check`. Deploy the shared API image to all production API roles through
the exact-SHA CI-gated wrapper. No static frontend deployment or schema migration
is required by these runtime changes. Production health checks do not substitute
for a real customer-channel acceptance test.

MAX reference: <https://dev.max.ru/docs-api/methods/PUT/messages>. Inline keyboard
updates use the existing edit transport, shared lock, and attachment preservation;
this change does not introduce a new MAX API method.
