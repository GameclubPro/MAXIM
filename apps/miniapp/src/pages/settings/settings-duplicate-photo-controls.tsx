import { SegmentedControl } from '../../components/ui/segmented-control';
import {
  DUPLICATE_PHOTO_SCOPE_OPTIONS,
  type DuplicatePhotoScope,
} from './settings-duplicate-photo-options';
import type { DuplicatePhotoPresentationPolicy } from './settings-duplicate-photo-status';

export default function SettingsDuplicatePhotoControls({
  moderationPolicy,
  scope,
  windowHours,
  onScopeChange,
}: {
  moderationPolicy: DuplicatePhotoPresentationPolicy;
  scope: DuplicatePhotoScope;
  windowHours: number;
  onScopeChange: (value: DuplicatePhotoScope) => void;
}) {
  return (
    <>
      <div className="settings-native-toggle duplicate-photo-toggle">
        <div className="settings-native-toggle__row">
          <span className="settings-native-toggle__title">Одинаковые картинки</span>
        </div>
        {moderationPolicy.moderationMode !== 'FULL' ? (
          <p className="policy-mode-hint" role="status">
            Проверка картинок сейчас недоступна
          </p>
        ) : null}
      </div>
      <div
        className="duplicate-photo-settings"
        role="group"
        aria-label="Удаление одинаковых картинок"
      >
        <div className="settings-policy duplicate-photo-settings__policy">
          <span className="field__label">Чьи картинки сравнивать</span>
          <SegmentedControl
            value={scope}
            options={DUPLICATE_PHOTO_SCOPE_OPTIONS}
            onChange={onScopeChange}
            className="settings-mode-segments duplicate-photo-settings__segments"
            ariaLabel="Чьи картинки сравнивать"
          />
        </div>
        <dl className="duplicate-diagnostics__facts">
          <div>
            <dt>Период проверки</dt>
            <dd>{windowHours} ч</dd>
          </div>
          <div>
            <dt>Подпись</dt>
            <dd>Не учитывается</dd>
          </div>
          <div>
            <dt>Действия</dt>
            <dd>Как для текста</dd>
          </div>
          <div>
            <dt>Счётчик повторов</dt>
            <dd>Отдельно для каждого участника</dd>
          </div>
        </dl>
      </div>
    </>
  );
}
