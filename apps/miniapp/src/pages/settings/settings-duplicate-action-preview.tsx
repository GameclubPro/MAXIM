import type {
  ChatSettings,
  DuplicateFlowStageSettings,
  DuplicatePhotoEffectivePolicy,
} from '@maxim/contracts/settings';
import { formatDuplicateActionSummary } from './settings-duplicate-photo-status';
import { SettingsHintAnchor } from './settings-hint-anchor';
import type { SettingsSectionHintProps } from './settings-section-shared';

export function buildDuplicateTextActionPreview(
  settings: DuplicateFlowStageSettings & Pick<ChatSettings, 'duplicateMuteDurationHours'>,
  allowedCount: number,
): Array<{ label: string; action: string }> {
  const rows = [{ label: 'Первое сообщение', action: 'Остаётся в чате' }];
  if (allowedCount > 0) {
    rows.push({
      label: allowedCount === 1 ? 'Дубль №1' : `Дубли №1–${allowedCount}`,
      action: allowedCount === 1 ? 'Остаётся в чате' : 'Остаются в чате',
    });
  }
  const actions: string[] = [];
  if (settings.duplicateBotMessageEnabled) actions.push('Удаление и объяснение');
  if (settings.duplicateWarnEnabled) actions.push('Удаление и предупреждение');
  if (settings.duplicateMuteEnabled) {
    actions.push(`Удаление и ограничение на ${settings.duplicateMuteDurationHours} ч`);
  }
  if (settings.duplicateBanEnabled) actions.push('Удаление и блокировка навсегда');
  if (actions.length === 0) actions.push('Удаление');
  actions.forEach((action, index) => {
    const last = index === actions.length - 1;
    rows.push({ label: `Дубль №${allowedCount + index + 1}${last ? ' и далее' : ''}`, action });
  });
  return rows;
}

export default function SettingsDuplicateActionPreview({
  draft,
  allowedCount,
  windowHours,
  photoPolicy,
  openHintKey,
  toggleHint,
}: Pick<SettingsSectionHintProps, 'openHintKey' | 'toggleHint'> & {
  draft: ChatSettings;
  allowedCount: number;
  windowHours: number;
  photoPolicy: DuplicatePhotoEffectivePolicy;
}) {
  const rows = buildDuplicateTextActionPreview(draft, allowedCount);
  return (
    <section className="duplicate-action-preview" aria-label="Итог действий антидубля">
      <div className="duplicate-stage__top">
        <h3 className="duplicate-stage__title">Действия для текста за {windowHours} ч</h3>
        <SettingsHintAnchor
          hintKey="duplicateActionSummary"
          openHintKey={openHintKey}
          onToggleHint={toggleHint}
          label="Полный итог действий антидубля"
        >
          {formatDuplicateActionSummary(draft, allowedCount, photoPolicy)}
        </SettingsHintAnchor>
      </div>
      <dl className="duplicate-action-preview__rows" aria-live="polite">
        {rows.map((row) => (
          <div className="duplicate-action-preview__row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.action}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
