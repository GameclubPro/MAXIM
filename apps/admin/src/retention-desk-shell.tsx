import type { SafetyDeskRetentionRuntimeResponse } from '@maxim/contracts/safety-desk';
import { lazy, Suspense } from 'react';
import { RetentionDeskLoadBoundary } from './retention-desk-load-boundary';
import type { RetentionDeskControls } from './retention-desk-state';
import { Metric } from './safety-desk-ui';

const RetentionDesk = lazy(() =>
  import('./retention-desk').then((module) => ({ default: module.RetentionDesk })),
);

export function RetentionDeskPane({
  accessCode,
  controls,
}: {
  accessCode: string;
  controls: RetentionDeskControls;
}) {
  return (
    <RetentionDeskLoadBoundary>
      <Suspense
        fallback={
          <p className="queue-empty" role="status">
            Загружаю раздел очистки…
          </p>
        }
      >
        <RetentionDesk
          accessCode={accessCode}
          refreshToken={controls.refreshToken}
          onSnapshot={controls.onSnapshot}
          onBusyChange={controls.onBusyChange}
        />
      </Suspense>
    </RetentionDeskLoadBoundary>
  );
}

export function RetentionRuntimeMetrics({
  runtime,
}: {
  runtime: SafetyDeskRetentionRuntimeResponse | null;
}) {
  return (
    <>
      <Metric label="Чатов на странице" value={String(runtime?.items.length ?? 0)} tone="neutral" />
      <Metric
        label="Нужна проверка"
        value={String(
          runtime?.items.filter((item) => item.hasTerminalReview || item.hasUnresolvedReceipt)
            .length ?? 0,
        )}
        tone="warning"
      />
    </>
  );
}
