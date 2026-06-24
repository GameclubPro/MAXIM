import type { ReactNode } from 'react';
import type { ChatSettings } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import { GlassCard } from '../../components/ui/glass-card';
import { cn } from '../../lib/cn';
import { SettingsHintAnchor } from './settings-page-helpers';
import type { HintKey } from './settings-page-helpers';

type CommentsDraft = Pick<
  ChatSettings,
  | 'commentsEnabled'
  | 'commentsAdminsEnabled'
  | 'commentsAllEnabled'
  | 'commentsChatBroadcastsEnabled'
>;

type SettingsCommentsSectionProps = {
  draft: CommentsDraft;
  expanded: boolean;
  summary: string;
  status: string;
  openHintKey: HintKey | null;
  isSaving: boolean;
  canSave: boolean;
  onToggleSection: () => void;
  onToggleHint: (key: HintKey) => void;
  onSave: () => void;
  onToggleCommentsEnabled: (enabled: boolean) => void;
  onFieldChange: (
    key: 'commentsAdminsEnabled' | 'commentsChatBroadcastsEnabled',
    value: boolean,
  ) => void;
};

function CommentsFooter({
  isSaving,
  canSave,
  onSave,
}: {
  isSaving: boolean;
  canSave: boolean;
  onSave: () => void;
}): ReactNode {
  return (
    <div className="settings-drilldown__footer-actions is-single-action">
      <button
        type="button"
        className="button button--accent"
        onClick={onSave}
        disabled={isSaving || !canSave}
      >
        {isSaving ? 'Сохраняем...' : 'Сохранить'}
      </button>
    </div>
  );
}

export function SettingsCommentsSection({
  draft,
  expanded,
  summary,
  status,
  openHintKey,
  isSaving,
  canSave,
  onToggleSection,
  onToggleHint,
  onSave,
  onToggleCommentsEnabled,
  onFieldChange,
}: SettingsCommentsSectionProps) {
  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
      style={{ animationDelay: '338ms', order: 3 }}
      aria-label="Комментарии"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title="Комментарии"
          summary={summary}
          status={status}
          icon="comments"
          tone="mint"
          open={expanded}
          controls="settings-comments-content"
          onClick={onToggleSection}
          hideChevron
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-comments-content"
        open={expanded}
        title="Комментарии"
        summary={summary}
        tone="mint"
        className="settings-drilldown__panel--board settings-drilldown__panel--comments"
        onClose={onToggleSection}
        footer={<CommentsFooter isSaving={isSaving} canSave={canSave} onSave={onSave} />}
      >
        <div
          id="settings-comments-content"
          className={cn('settings-section__collapse', expanded && 'is-open')}
        >
          {expanded ? (
            <div className="settings-section__collapse-inner">
              <div className="settings-native-toggle">
                <div className="settings-native-toggle__row">
                  <div className="settings-native-toggle__title-wrap">
                    <span className="settings-native-toggle__title">Включить комментарии</span>
                    <div className="settings-native-toggle__title-actions">
                      <SettingsHintAnchor
                        hintKey="commentsEnabled"
                        openHintKey={openHintKey}
                        onToggleHint={onToggleHint}
                        label="Как работают комментарии в чатах"
                      >
                        В MAX нет нативных комментариев под сообщениями в чатах, поэтому бот сам
                        публикует сообщение с кнопкой комментариев. Для постов админа бот
                        отправляет копию с той же разметкой и удаляет исходное сообщение, а для
                        автопостинга кнопка ставится сразу на сообщение бота.
                      </SettingsHintAnchor>
                    </div>
                  </div>

                  <label className="settings-native-switch" aria-label="Включить комментарии в чатах">
                    <input
                      type="checkbox"
                      checked={draft.commentsEnabled}
                      onChange={(event) => onToggleCommentsEnabled(event.target.checked)}
                    />
                    <span className="toggle-switch" aria-hidden>
                      <span className="toggle-switch__thumb" />
                    </span>
                  </label>
                </div>
              </div>

              {draft.commentsEnabled ? (
                <>
                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Только у админов</span>
                        <div className="settings-native-toggle__title-actions">
                          <SettingsHintAnchor
                            hintKey="commentsAdmins"
                            openHintKey={openHintKey}
                            onToggleHint={onToggleHint}
                            label="Как работают комментарии для постов админов"
                          >
                            Когда пишет админ, бот публикует такое же сообщение от себя с кнопкой
                            комментариев и удаляет исходное. Это нужно, потому что MAX не умеет
                            вешать кнопку прямо под сообщением человека в чате.
                          </SettingsHintAnchor>
                        </div>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Комментарии под постами админов"
                      >
                        <input
                          type="checkbox"
                          checked={draft.commentsAdminsEnabled}
                          onChange={(event) =>
                            onFieldChange('commentsAdminsEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="settings-native-toggle">
                    <div className="settings-native-toggle__row">
                      <div className="settings-native-toggle__title-wrap">
                        <span className="settings-native-toggle__title">Для автопостинга</span>
                        <div className="settings-native-toggle__title-actions">
                          <SettingsHintAnchor
                            hintKey="commentsChatBroadcasts"
                            openHintKey={openHintKey}
                            onToggleHint={onToggleHint}
                            label="Как работают комментарии для автопостинга"
                          >
                            Для автопостинга бот публикует сообщение сам и сразу добавляет в него
                            кнопку комментариев. Сообщения участников чата при этом не заменяются.
                          </SettingsHintAnchor>
                        </div>
                      </div>

                      <label
                        className="settings-native-switch"
                        aria-label="Комментарии для автопостинга в чатах"
                      >
                        <input
                          type="checkbox"
                          checked={draft.commentsChatBroadcastsEnabled}
                          onChange={(event) =>
                            onFieldChange('commentsChatBroadcastsEnabled', event.target.checked)
                          }
                        />
                        <span className="toggle-switch" aria-hidden>
                          <span className="toggle-switch__thumb" />
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
