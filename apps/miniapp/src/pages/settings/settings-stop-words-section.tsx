import { Suspense, useState, type Dispatch, type SetStateAction } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/cn';
import type { ApiTransport } from '../../lib/api/transport';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type {
  SettingsSectionEditorProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsStopWordsSectionProps = SettingsSectionShellProps &
  Pick<SettingsSectionEditorProps, 'botSpeechPreviewContext'> &
  Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue' | 'clearFieldError'> & {
    api: ApiTransport;
    chatId: string;
    busy: boolean;
    reloadPolicy: () => Promise<void>;
    messageLimitsBlockedWordsInput: string;
    messageLimitsBlockedDomainsInput: string;
    messageLimitsBlockedWordsError?: string;
    messageLimitsBlockedDomainsError?: string;
    stopWordsError?: string;
    setMessageLimitsBlockedWordsInput: Dispatch<SetStateAction<string>>;
    setMessageLimitsBlockedDomainsInput: Dispatch<SetStateAction<string>>;
  };

export type SettingsStopWordsEditorProps = SettingsStopWordsSectionProps & {
  mode: 'words' | 'domains';
  onModeChange: (mode: 'words' | 'domains') => void;
};

const LazySettingsStopWordsEditor = recoverableLazyNamedComponent<SettingsStopWordsEditorProps>(
  () => import('./settings-stop-words-editor'),
  'SettingsStopWordsEditor',
);

export function SettingsStopWordsSection(props: SettingsStopWordsSectionProps) {
  const [mode, setMode] = useState<'words' | 'domains'>('words');
  const {
    discardSectionChanges,
    expanded,
    isSectionDirty,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    toggleSection,
  } = props;
  const policy = props.draft.stopWordsPolicy;
  const count = policy
    ? policy.rules.filter((rule) => rule.enabled).length + policy.domains.length
    : 0;
  const stopWordsCardStatus = !policy ? 'Проверить' : policy.enabled ? String(count) : 'Выкл';
  const stopWordsHeaderSummary = !policy
    ? 'Требуется проверка списка'
    : policy.enabled
      ? `Активно: ${count}`
      : 'Выключено';

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
              <LazySettingsStopWordsEditor {...props} mode={mode} onModeChange={setMode} />
            </Suspense>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
