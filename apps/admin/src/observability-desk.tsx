import { PublicationCohortDesk } from './publication-cohort-desk';
import { WebhookCohortDesk } from './webhook-cohort-desk';
import { DeleteCohortDesk } from './delete-cohort-desk';
import { PublicationDeliveryCohortDesk } from './publication-delivery-cohort-desk';
import { useState } from 'react';

const families = {
  webhook: 'Входящие события',
  deletion: 'Намерения удаления',
  publication: 'Запуски Публика',
  delivery: 'Доставки Публика',
} as const;

export function ObservabilityDesk(props: { accessCode: string; refreshToken: number }) {
  const [family, setFamily] = useState<keyof typeof families>('webhook');
  return (
    <div className="observation-panels">
      <nav className="observation-selector" aria-label="Вид наблюдений">
        {(Object.keys(families) as Array<keyof typeof families>).map((key) => (
          <button
            key={key}
            className="ghost-action"
            type="button"
            aria-pressed={family === key}
            onClick={() => setFamily(key)}
          >
            {families[key]}
          </button>
        ))}
      </nav>
      {family === 'webhook' && <WebhookCohortDesk {...props} />}
      {family === 'publication' && <PublicationCohortDesk {...props} />}
      {family === 'deletion' && <DeleteCohortDesk {...props} />}
      {family === 'delivery' && <PublicationDeliveryCohortDesk {...props} />}
    </div>
  );
}
