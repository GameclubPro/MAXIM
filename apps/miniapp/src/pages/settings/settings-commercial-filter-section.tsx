import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';
import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
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

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'commercialFilter');

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
      style={{ animationDelay: '135ms', order: SECTION_PRESENTATION.order }}
      aria-label="Коммерческая реклама"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          enabled={props.draft.commercialAdsFilterEnabled}
          summary={commercialFilterHeaderSummary}
          status={commercialFilterCardStatus}
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-commercial-filter-content"
          onClick={() => toggleSection('commercialFilter')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-commercial-filter-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        summary={commercialFilterHeaderSummary}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={() => toggleSection('commercialFilter')}
        headerAction={renderApplyTargetHeaderAction('commercialFilter')}
        confirmCloseWhen={isSectionDirty('commercialFilter')}
        onDiscardChanges={() => discardSectionChanges('commercialFilter')}
        footer={renderSectionSaveFooter('commercialFilter')}
      >
        {props.sharedContent ? (
          <>{expanded ? props.sharedContent : null}</>
        ) : (
          <>
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
          </>
        )}
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
