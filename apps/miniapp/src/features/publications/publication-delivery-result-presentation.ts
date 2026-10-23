import type { PublicationSummary } from '@maxim/contracts/publication';
import {
  getPublicationActionableDelivery,
  getPublicationDispatchPendingCount,
} from './publication-model';

export function getPublicationDeliveryResultPresentation(
  publication: Pick<PublicationSummary, 'delivery' | 'actionableDelivery'>,
): { headline: string; currentFacts: string[]; needsAttention: boolean } {
  const lifetime = publication.delivery;
  const actionable = getPublicationActionableDelivery(publication);
  const pending = getPublicationDispatchPendingCount(actionable);
  return {
    headline:
      lifetime.total > 0
        ? `Опубликовано ${lifetime.sent} из ${lifetime.total}`
        : 'Отправки ещё не начались',
    currentFacts: [
      pending > 0 ? `В очереди или отправляется: ${pending}` : null,
      actionable.ambiguous > 0 ? `Нужно проверить: ${actionable.ambiguous}` : null,
      actionable.failed > 0 ? `С ошибкой: ${actionable.failed}` : null,
    ].filter((item): item is string => item !== null),
    needsAttention: actionable.ambiguous > 0 || actionable.failed > 0,
  };
}
