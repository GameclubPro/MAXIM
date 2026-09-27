# Publisher Comment Notifications

Publisher comment notifications use the exact Publisher bot and signed comment thread. Major subscriptions and private delivery remain independent. The notification settings endpoint accepts the authenticated profile; a Major token cannot authorize a Publisher thread.

## Subscription Behavior

- Explicit post settings override entity settings, which override global settings. Explicit OFF is preserved when a user comments again.
- Commenting subscribes the author to replies implicitly. Replying to an older Publisher comment also creates the original author's implicit subscription when absent.
- Global settings apply only to fresh Publisher-managed admin access, active Publisher connections, and enabled publication policy. Direct signed post/entity subscriptions remain available to participants.
- The author receives no notification about their own comment. A reply recipient who also selected all comments receives one message.
- The private Publik bot must be started and unblocked. Stored preferences do not prove that MAX can deliver a private message or that the phone will show a push notification.
- Old comments are not replayed. New notifications expire after 24 hours.

## Delivery And Recovery

`createCommentDialogAudit` commits the comment, implicit preferences, and `PublisherCommentNotificationEvent` together under the existing comment-sanction lock. Redis admission is only a wakeup: a lost job does not discard the PostgreSQL outbox.

The existing `publisher-chat-comments` queue carries `deliver_notification` jobs. Only `api-publisher` runs delivery and the 30-second bounded recovery lane. It checks Publisher runtime, attestation, dispatch health, publication readiness, comment existence, and current preferences before dispatch. Disabling new comment-button creation does not disable existing signed discussions.

Fanout pages contain at most 100 preferences; dispatch batches contain at most 10 recipients and yield after 20 seconds. Healthy unfinished batches enqueue a continuation. Recovery scans at most 20 events per interval. Recipient uniqueness and an event lease prevent concurrent duplicate sends.

Recipient status meanings:

| Status    | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `PENDING` | Waiting for dispatch or a safe retry, at most 12 attempts              |
| `SENDING` | Durable marker committed immediately before the MAX send               |
| `SENT`    | MAX returned a message ID and the receipt was persisted                |
| `SKIPPED` | Comment removed or the current subscription does not permit delivery   |
| `FAILED`  | Definitive rejection, such as private delivery 403/404, or retry limit |
| `UNKNOWN` | Send may have succeeded; automatic replay is prohibited                |

429 and failures before dispatch retry with bounded backoff. Timeouts, ambiguous 5xx responses after dispatch, and interrupted `SENDING` records are quarantined. A receipt-write failure never resets the send marker. Do not reset `UNKNOWN` or `SENDING` to retry without independent evidence about remote delivery.

Completed outbox data becomes eligible for cleanup seven days after notification expiry. Each recovery pass removes at most 100 recipient rows from each of five expired events before deleting empty events. Preferences remain until changed by their user.

## Verification

- `npm test --workspace @maxim/api -- publisher-comment-notification publisher-dialog-profile-runtime.spec.ts`
- `npm run test:postgres-races --workspace @maxim/api` with the existing disposable local PostgreSQL race-test environment.
- `node apps/miniapp/test/comment-notifications.browser.mjs` checks Publisher settings at 320 px, iPhone and Android sizes in both themes, including polling, failed saves, scope changes, keyboard navigation, and screenshots.
- `npm run check:prisma` and the migrated-database drift check validate the additive schema.

The normal shared API and mini app release applies the migration and recreates the complete API fleet. The notification queue, runtime topology, credentials, and secret mounts do not change.
