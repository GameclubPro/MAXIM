import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import type { ApiTransport } from '../../lib/api/transport';
import type { BroadcastLinkButtonFieldErrors } from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { FieldErrors } from './settings-page-helpers';
import type {
  SettingsSectionEditorProps,
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsLimitsSectionProps = SettingsSectionShellProps &
  Pick<
    SettingsSectionEditorProps,
    | 'botSpeechEditorProps'
    | 'botSpeechPreviewContext'
    | 'openBotEditorKey'
    | 'setOpenBotEditorKey'
    | 'toggleBotMessageEditor'
  > &
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
    adjustStickerMessageCooldown: (deltaMinutes: number) => void;
    deleteSpammersRuntimeStatus: string;
    fieldErrors: FieldErrors;
    hasMessageLimitsBotButtonError: boolean;
    limitsCardStatus: string;
    limitsRulesEnabledCount: number;
    messageLimitsBotButtonErrors: BroadcastLinkButtonFieldErrors[];
    spammerReviewMetricsQuery: {
      data?: { enforcementMode?: string };
    };
  };

const LazySettingsLimitsEditor = recoverableLazyNamedComponent<SettingsLimitsSectionProps>(
  () => import('./settings-limits-editor'),
  'SettingsLimitsEditor',
);

export function SettingsLimitsSection(props: SettingsLimitsSectionProps) {
  const {
    discardSectionChanges,
    expanded,
    isSectionDirty,
    limitsCardStatus,
    limitsRulesEnabledCount,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    toggleSection,
  } = props;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
      style={{ animationDelay: '225ms', order: 2 }}
      aria-label="Ограничения"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Ограничения"
          summary={`Активных ограничений: ${limitsRulesEnabledCount}`}
          status={limitsCardStatus}
          icon="shield"
          tone="ink"
          open={expanded}
          controls="settings-limits-content"
          onClick={() => toggleSection('limits')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-limits-content"
        open={expanded}
        title="Ограничения"
        summary={`Активных ограничений: ${limitsRulesEnabledCount}`}
        tone="ink"
        className="settings-drilldown__panel--ladder settings-drilldown__panel--limits"
        onClose={() => toggleSection('limits')}
        headerAction={renderApplyTargetHeaderAction('limits')}
        confirmCloseWhen={isSectionDirty('limits')}
        onDiscardChanges={() => discardSectionChanges('limits')}
        footer={renderSectionSaveFooter('limits')}
      >
        <div
          id="settings-limits-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <Suspense fallback={<Spinner label="Загружаем ограничения" />}>
              <LazySettingsLimitsEditor {...props} />
            </Suspense>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
