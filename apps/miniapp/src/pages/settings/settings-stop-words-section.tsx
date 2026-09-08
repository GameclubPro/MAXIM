import { Suspense, type Dispatch, type SetStateAction } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import type { SegmentedOption } from '../../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { StopWordsMode } from '../settings-page.constants';
import type {
  SettingsSectionEditorProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsStopWordsSectionProps = SettingsSectionShellProps &
  SettingsSectionEditorProps &
  Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue' | 'clearFieldError'> & {
    addMessageLimitsBlockedDomains: () => void;
    addMessageLimitsBlockedWords: () => void;
    applyMessageLimitsBlockedWords: (nextWords: string[]) => void;
    hasMessageLimitsBlockedDomainsOverflow: boolean;
    hasMessageLimitsBlockedDomainsRemoveInputActions: boolean;
    hasMessageLimitsBlockedWordsOverflow: boolean;
    hasMessageLimitsBlockedWordsRemoveInputActions: boolean;
    isMessageLimitsBlockedDomainsApplyDisabled: boolean;
    isMessageLimitsBlockedWordsApplyDisabled: boolean;
    messageLimitsBlockedDomains: string[];
    messageLimitsBlockedDomainsCaption: string;
    messageLimitsBlockedDomainsError?: string;
    messageLimitsBlockedDomainsExpanded: boolean;
    messageLimitsBlockedDomainsInput: string;
    messageLimitsBlockedWords: string[];
    messageLimitsBlockedWordsCaption: string;
    messageLimitsBlockedWordsError?: string;
    messageLimitsBlockedWordsExpanded: boolean;
    messageLimitsBlockedWordsInput: string;
    messageLimitsBlockedWordsRemaining: number;
    removeMessageLimitsBlockedDomain: (domain: string) => void;
    removeMessageLimitsBlockedWord: (word: string) => void;
    setMessageLimitsBlockedDomainsExpanded: Dispatch<SetStateAction<boolean>>;
    setMessageLimitsBlockedDomainsInput: Dispatch<SetStateAction<string>>;
    setMessageLimitsBlockedWordsExpanded: Dispatch<SetStateAction<boolean>>;
    setMessageLimitsBlockedWordsInput: Dispatch<SetStateAction<string>>;
    setStopWordsMode: Dispatch<SetStateAction<StopWordsMode>>;
    stopWordsCardStatus: string;
    stopWordsError?: string;
    stopWordsHeaderSummary: string;
    stopWordsMode: StopWordsMode;
    stopWordsSegmentOptions: Array<SegmentedOption<StopWordsMode>>;
    visibleMessageLimitsBlockedDomains: string[];
    visibleMessageLimitsBlockedWords: string[];
  };

const LazySettingsStopWordsEditor = recoverableLazyNamedComponent<SettingsStopWordsSectionProps>(
  () => import('./settings-stop-words-editor'),
  'SettingsStopWordsEditor',
);

export function SettingsStopWordsSection(props: SettingsStopWordsSectionProps) {
  const {
    discardSectionChanges,
    expanded,
    isSectionDirty,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    stopWordsCardStatus,
    stopWordsHeaderSummary,
    toggleSection,
  } = props;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '214ms', order: 13 }}
      aria-label="Стоп-слова"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Стоп-слова"
          summary={stopWordsHeaderSummary}
          status={stopWordsCardStatus}
          icon="keywords"
          tone="rose"
          open={expanded}
          controls="settings-stop-words-content"
          onClick={() => toggleSection('stopWords')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-stop-words-content"
        open={expanded}
        title="Стоп-слова"
        summary={stopWordsHeaderSummary}
        tone="rose"
        className="settings-drilldown__panel--board settings-drilldown__panel--stop-words"
        onClose={() => toggleSection('stopWords')}
        headerAction={renderApplyTargetHeaderAction('stopWords')}
        confirmCloseWhen={isSectionDirty('stopWords')}
        onDiscardChanges={() => discardSectionChanges('stopWords')}
        footer={renderSectionSaveFooter('stopWords')}
      >
        <div
          id="settings-stop-words-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <Suspense fallback={<Spinner label="Загружаем стоп-слова" />}>
              <LazySettingsStopWordsEditor {...props} />
            </Suspense>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
