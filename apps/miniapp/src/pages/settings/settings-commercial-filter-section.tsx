import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import type { ApiTransport } from '../../lib/api/transport';
import type { BroadcastLinkButtonFieldErrors } from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type {
  SettingsSectionEditorProps,
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsCommercialFilterSectionProps = SettingsSectionShellProps &
  SettingsSectionEditorProps &
  SettingsSectionHintProps &
  Pick<
    SettingsSectionMutationProps,
    | 'draft'
    | 'setFieldValue'
    | 'clearButtonGroupErrors'
    | 'updateDraftButtonGroup'
    | 'renderAdminContactToggle'
    | 'renderMuteStageToggle'
  > & {
    api: ApiTransport;
    commercialFilterCardStatus: string;
    commercialFilterHeaderSummary: string;
    commercialSensitivityLabel: string;
    commercialSensitivitySliderValue: number | null;
    commercialPhotoModerationMode: 'OFF' | 'OBSERVE' | 'FULL' | 'UNKNOWN';
    handleCommercialSensitivitySliderChange: (value: number) => void;
    hasTextFiltersBotButtonError: boolean;
    textFiltersBotButtonErrors: BroadcastLinkButtonFieldErrors[];
  };

const LazySettingsCommercialFilterEditor =
  recoverableLazyNamedComponent<SettingsCommercialFilterSectionProps>(
    () => import('./settings-commercial-filter-editor'),
    'SettingsCommercialFilterEditor',
  );

export function SettingsCommercialFilterSection(props: SettingsCommercialFilterSectionProps) {
  const {
    commercialFilterCardStatus,
    commercialFilterHeaderSummary,
    discardSectionChanges,
    expanded,
    isSectionDirty,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    toggleSection,
  } = props;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '135ms', order: 12 }}
      aria-label="Коммерческая реклама"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Коммерческая реклама"
          summary={commercialFilterHeaderSummary}
          status={commercialFilterCardStatus}
          icon="ads"
          tone="amber"
          open={expanded}
          controls="settings-commercial-filter-content"
          onClick={() => toggleSection('commercialFilter')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-commercial-filter-content"
        open={expanded}
        title="Коммерческая реклама"
        summary={commercialFilterHeaderSummary}
        tone="amber"
        className="settings-drilldown__panel--ladder settings-drilldown__panel--commercial"
        onClose={() => toggleSection('commercialFilter')}
        headerAction={renderApplyTargetHeaderAction('commercialFilter')}
        confirmCloseWhen={isSectionDirty('commercialFilter')}
        onDiscardChanges={() => discardSectionChanges('commercialFilter')}
        footer={renderSectionSaveFooter('commercialFilter')}
      >
        <div
          id="settings-commercial-filter-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <Suspense fallback={<Spinner label="Загружаем фильтр рекламы" />}>
              <LazySettingsCommercialFilterEditor {...props} />
            </Suspense>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
