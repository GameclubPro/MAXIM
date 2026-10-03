import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { publicationDetailsSchema } from '@maxim/contracts/publication';
import { usePublicationActions } from '../../src/features/publications/use-publication-actions';
import { usePublicationRequestIds } from '../../src/features/publications/use-publication-request-ids';
import {
  PublicationActionSheet,
  PublicationDeliveryActionSheets,
} from '../../src/features/publications/publication-action-sheets';
import { ToastProvider } from '../../src/components/ui/toast';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.message), { code: data.code, status: response.status });
    return data;
  },
  requestKeepalive() {},
};
const details = publicationDetailsSchema.parse({
  id: 'publication-a',
  title: 'Проверка действий',
  lifecycle: 'ACTIVE',
  version: 4,
  contentPreview: 'Текст',
  targetCount: 0,
  targetPreviews: [],
  targetOverflowCount: 0,
  audienceSelection: 'SELECTED',
  audienceMode: 'SNAPSHOT',
  mediaCount: 0,
  hasVideo: false,
  schedule: null,
  delivery: { total: 1, pending: 0, sent: 0, failed: 1, ambiguous: 0, canceled: 0 },
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  content: { revision: 3, text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
  targets: [],
  occurrences: [
    {
      id: 'occurrence-a',
      scheduledAt: '2026-10-01T10:00:00Z',
      status: 'FAILED',
      canRetry: true,
      contentRevision: 1,
      delivery: { total: 1, pending: 0, sent: 0, failed: 1, ambiguous: 0, canceled: 0 },
    },
  ],
});
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
for (const key of [
  ['publications', 'list'],
  ['publications', 'calendar'],
  ['publications', 'details'],
  ['publications', 'deliveries'],
])
  queryClient.setQueryData(key, 'baseline');
function Harness() {
  const identities = usePublicationRequestIds();
  const actions = usePublicationActions(api, identities);
  const busy =
    actions.actionMutation.isPending ||
    actions.retryMutation.isPending ||
    actions.resolveAmbiguousMutation.isPending;
  return (
    <main>
      <button
        disabled={busy}
        onClick={() => {
          actions.setDetailsTarget(details);
          actions.setActionTarget({ publication: details, action: 'cancel' });
        }}
      >
        Отмена публикации
      </button>
      <button
        disabled={busy}
        onClick={() => actions.setActionTarget({ publication: details, action: 'pause' })}
      >
        Пауза расписания
      </button>
      <button
        disabled={busy}
        onClick={() => actions.setActionTarget({ publication: details, action: 'resume' })}
      >
        Возобновление расписания
      </button>
      <button
        disabled={busy}
        onClick={() => actions.requestPublicationRetry(details, details.occurrences[0])}
      >
        Повтор устаревшего
      </button>
      <button
        disabled={busy}
        onClick={() =>
          actions.requestPublicationRetry(details, {
            ...details.occurrences[0],
            contentRevision: 3,
          })
        }
      >
        Повтор актуального
      </button>
      <button
        disabled={busy}
        onClick={() =>
          actions.setAmbiguousTarget({
            publicationId: details.id,
            occurrenceId: 'occurrence-a',
            deliveryId: 'delivery-a',
            resolution: 'mark_sent',
          })
        }
      >
        Решить неопределённость
      </button>
      <PublicationActionSheet actions={actions} />
      <PublicationDeliveryActionSheets actions={actions} />
      <output data-testid="state">
        {JSON.stringify({
          action: actions.actionTarget?.action ?? null,
          retry: actions.retryChoiceTarget !== null,
          ambiguous: actions.ambiguousTarget !== null,
          details: actions.detailsTarget?.id ?? null,
          busy,
          invalidated: queryClient
            .getQueryCache()
            .getAll()
            .filter((q) => q.state.isInvalidated)
            .map((q) => q.queryKey[1]),
          response: details,
        })}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <Harness />
    </ToastProvider>
  </QueryClientProvider>,
);
