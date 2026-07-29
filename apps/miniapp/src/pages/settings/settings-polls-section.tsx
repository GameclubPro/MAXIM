import { StatsUpSquare } from 'iconoir-react';
import { Suspense, useRef } from 'react';
import type { ManagedPollWorkspaceHandle } from '../../components/managed-poll-workspace';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { SkeletonCard } from '../../components/ui/skeleton';
import type { ApiTransport } from '../../lib/api/transport';
import { cn } from '../../lib/cn';
import { LazyManagedPollWorkspace } from './settings-page-helpers';

type SettingsPollsSectionProps = {
  api: ApiTransport;
  chatId: string;
  expanded: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export function SettingsPollsSection({
  api,
  chatId,
  expanded,
  onOpen,
  onClose,
}: SettingsPollsSectionProps) {
  const workspaceRef = useRef<ManagedPollWorkspaceHandle | null>(null);

  const requestClose = () => {
    if (workspaceRef.current) {
      workspaceRef.current.requestClose();
      return;
    }
    onClose();
  };

  const toggleSection = () => {
    if (expanded) {
      requestClose();
      return;
    }
    onOpen();
  };

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '52ms', order: 24 }}
      aria-label="Опросы"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Опросы"
          summary=""
          status="Голоса"
          icon={<StatsUpSquare aria-hidden focusable="false" />}
          tone="mint"
          open={expanded}
          controls="settings-polls-content"
          onClick={toggleSection}
          hideChevron
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-polls-content"
        open={expanded}
        title="Опросы"
        tone="mint"
        variant="screen"
        className="settings-drilldown__panel--campaign settings-drilldown__panel--polls"
        onClose={requestClose}
      >
        <div
          id="settings-polls-collapse"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner">
              <Suspense fallback={<SkeletonCard lines={4} />}>
                <LazyManagedPollWorkspace
                  key={`chat:${chatId}`}
                  ref={workspaceRef}
                  api={api}
                  entityType="chat"
                  entityId={chatId}
                  onClosePanel={onClose}
                />
              </Suspense>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
