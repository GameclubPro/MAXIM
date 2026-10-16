import { PublicationCohortDesk } from './publication-cohort-desk';
import { WebhookCohortDesk } from './webhook-cohort-desk';

export function ObservabilityDesk(props: { accessCode: string; refreshToken: number }) {
  return (
    <div className="observation-panels">
      <WebhookCohortDesk {...props} />
      <PublicationCohortDesk {...props} />
    </div>
  );
}
