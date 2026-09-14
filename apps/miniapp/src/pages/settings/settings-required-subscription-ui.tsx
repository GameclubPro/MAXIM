import { NavArrowDown, Plus } from 'iconoir-react';
import { useId, useState, type ReactNode } from 'react';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import { cn } from '../../lib/cn';
import { SettingsHintAnchor } from './settings-hint-anchor';

export function RequiredSubscriptionHelp() {
  const [open, setOpen] = useState(false);
  useHintPopoverAutoPosition(open, 'requiredSubscriptionEnabled', () => setOpen(false));

  return (
    <SettingsHintAnchor
      hintKey="requiredSubscriptionEnabled"
      openHintKey={open ? 'requiredSubscriptionEnabled' : null}
      onToggleHint={() => setOpen((current) => !current)}
      label="Как работает обязательная подписка"
    >
      Помогает привлекать подписчиков в ваши чаты и каналы: чтобы писать здесь, участник должен
      подписаться на все выбранные источники. Без подписки бот удаляет сообщение и отправляет
      ссылки. За повторные сообщения применяются включённые ниже меры.
    </SettingsHintAnchor>
  );
}

export function RequiredSubscriptionSourceDisclosure({
  initiallyOpen,
  children,
}: {
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const contentId = useId();

  return (
    <div className="required-subscription__add-source">
      <button
        type="button"
        className="required-subscription__add-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus aria-hidden />
        <span>Добавить источник</span>
        <NavArrowDown aria-hidden className={open ? 'is-open' : undefined} />
      </button>
      <div id={contentId} hidden={!open} className="required-subscription__add-content">
        {open ? children : null}
      </div>
    </div>
  );
}

export function RequiredSubscriptionExternalSource({
  value,
  error,
  loading,
  limitReached,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string;
  loading: boolean;
  limitReached: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const errorId = useId();
  const disabled = loading || limitReached || !value.trim();

  return (
    <div className="required-subscription__external-source">
      <div className="managed-giveaway__editor-grid">
        <label className={cn('field settings-text-field', error && 'field--error')}>
          <span>Добавить по ссылке</span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!disabled) onSubmit();
              }
            }}
            placeholder="https://max.ru/..."
            disabled={loading}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          />
          {error ? (
            <small id={errorId} className="field__hint" role="alert">
              {error}
            </small>
          ) : null}
        </label>
        <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
          <button
            type="button"
            className="button button--accent managed-giveaway__channel-action"
            disabled={disabled}
            aria-busy={loading}
            onClick={onSubmit}
          >
            {loading ? 'Проверяем...' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  );
}
