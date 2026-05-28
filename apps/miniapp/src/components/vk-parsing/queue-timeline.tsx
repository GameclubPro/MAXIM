import type { VkParsingPost } from '@maxim/contracts';

type QueueTimelineProps = {
  posts: VkParsingPost[];
  schedulingPostId: string | null;
  cancelingPostId: string | null;
  publishingNowPostId: string | null;
  onSchedulePost: (postId: string, scheduledAt: string) => void;
  onCancelPost: (postId: string) => void;
  onPublishNow: (postId: string) => void;
};

const DROP_SLOTS = [
  { label: '+30м', offsetMs: 30 * 60_000 },
  { label: '+2ч', offsetMs: 2 * 60 * 60_000 },
  { label: '09:00', offsetMs: null },
];

function toDatetimeLocal(value: string | null): string {
  const date = value ? new Date(value) : new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

function resolveSlotDate(slot: (typeof DROP_SLOTS)[number]): string {
  const now = new Date();
  if (typeof slot.offsetMs === 'number') {
    return new Date(now.getTime() + slot.offsetMs).toISOString();
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function formatQueueTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function QueueTimeline({
  posts,
  schedulingPostId,
  cancelingPostId,
  publishingNowPostId,
  onSchedulePost,
  onCancelPost,
  onPublishNow,
}: QueueTimelineProps) {
  if (posts.length === 0) {
    return null;
  }

  return (
    <section className="vk-queue-timeline" aria-label="Очередь публикаций">
      <div className="vk-queue-drop-row">
        {DROP_SLOTS.map((slot) => (
          <button
            key={slot.label}
            type="button"
            className="vk-queue-drop-slot"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const postId = event.dataTransfer.getData('text/plain');
              if (postId) {
                onSchedulePost(postId, resolveSlotDate(slot));
              }
            }}
          >
            {slot.label}
          </button>
        ))}
      </div>

      <div className="vk-queue-list">
        {posts.map((post) => (
          <article
            key={post.id}
            className="vk-queue-item"
            draggable
            onDragStart={(event) => event.dataTransfer.setData('text/plain', post.id)}
          >
            <div className="vk-queue-item__main">
              <strong>{post.sourceTitle}</strong>
              <span>{formatQueueTime(post.publishScheduledAt ?? post.publishQueuedAt)}</span>
            </div>
            <input
              type="datetime-local"
              value={toDatetimeLocal(post.publishScheduledAt ?? post.publishQueuedAt)}
              disabled={schedulingPostId === post.id}
              onChange={(event) => onSchedulePost(post.id, fromDatetimeLocal(event.target.value))}
            />
            <div className="vk-queue-item__actions">
              <button
                type="button"
                className="vk-source-preset"
                disabled={publishingNowPostId === post.id}
                onClick={() => onPublishNow(post.id)}
              >
                Сейчас
              </button>
              <button
                type="button"
                className="vk-source-preset"
                disabled={cancelingPostId === post.id}
                onClick={() => onCancelPost(post.id)}
              >
                Снять
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
