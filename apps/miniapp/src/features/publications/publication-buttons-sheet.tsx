import type { BroadcastLinkButton } from '@maxim/contracts';
import { MAX_PUBLICATION_BUTTONS, publicationButtonSchema } from '@maxim/contracts/publication';
import { Plus as IconoirPlus, Xmark as IconoirXmark } from 'iconoir-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  createEmptyBroadcastLinkButton,
  hasBroadcastLinkButtonErrors,
  type BroadcastLinkButtonFieldErrors,
} from '../../lib/broadcast-link-buttons';
import { useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import './publication-buttons-sheet.css';

export type PublicationButtonsSheetProps = {
  open: boolean;
  buttons: BroadcastLinkButton[];
  disabled?: boolean;
  onApply: (buttons: BroadcastLinkButton[]) => void;
  onClose: () => void;
};

type TouchedButtonFields = {
  text?: boolean;
  url?: boolean;
};

function createWorkingButtons(buttons: BroadcastLinkButton[]): BroadcastLinkButton[] {
  const source = buttons.length > 0 ? buttons : [createEmptyBroadcastLinkButton()];
  return source.slice(0, MAX_PUBLICATION_BUTTONS).map((button) => ({ ...button }));
}

function validatePublicationButtons(
  buttons: BroadcastLinkButton[],
): BroadcastLinkButtonFieldErrors[] {
  return buttons.map((button) => {
    const parsed = publicationButtonSchema.safeParse({ ...button, row: 0 });
    if (parsed.success) {
      return {};
    }

    const errors: BroadcastLinkButtonFieldErrors = {};
    if (parsed.error.issues.some((issue) => issue.path[0] === 'text')) {
      errors.text = 'Введите название кнопки до 32 символов.';
    }
    if (parsed.error.issues.some((issue) => issue.path[0] === 'url')) {
      errors.url = 'Укажите корректную ссылку (http/https).';
    }
    return errors;
  });
}

function resolvePublicationButtonsPortalTarget(): Element | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.querySelector('.design-preview__device-screen') ?? document.body;
}

function revealTouchedErrors(
  errors: BroadcastLinkButtonFieldErrors[],
  touched: TouchedButtonFields[],
): BroadcastLinkButtonFieldErrors[] {
  return errors.map((error, index) => ({
    text: touched[index]?.text ? error.text : undefined,
    url: touched[index]?.url ? error.url : undefined,
  }));
}

export function PublicationButtonsSheet({
  open,
  buttons,
  disabled = false,
  onApply,
  onClose,
}: PublicationButtonsSheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const textInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const urlInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const wasOpenRef = useRef(false);
  const fieldId = useId();
  const [workingButtons, setWorkingButtons] = useState(() => createWorkingButtons(buttons));
  const [touchedFields, setTouchedFields] = useState<TouchedButtonFields[]>([]);
  const validationErrors = validatePublicationButtons(workingButtons);
  const visibleErrors = revealTouchedErrors(validationErrors, touchedFields);

  useDialogFocusTrap(open, panelRef, closeButtonRef);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setWorkingButtons(createWorkingButtons(buttons));
      setTouchedFields([]);
    }
    wasOpenRef.current = open;
  }, [buttons, open]);

  useEffect(() => {
    if (!open || workingButtons.length === 0) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      textInputRefs.current[0]?.focus();
      textInputRefs.current[0]?.select();
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, [open]);

  const discard = useCallback(() => {
    setWorkingButtons(createWorkingButtons(buttons));
    setTouchedFields([]);
    onClose();
  }, [buttons, onClose]);

  const apply = useCallback(() => {
    if (disabled) {
      return;
    }
    if (workingButtons.length === 0) {
      setWorkingButtons(createWorkingButtons([]));
      setTouchedFields([]);
      onApply([]);
      return;
    }

    const nextErrors = validatePublicationButtons(workingButtons);
    if (hasBroadcastLinkButtonErrors(nextErrors)) {
      setTouchedFields(workingButtons.map(() => ({ text: true, url: true })));
      window.requestAnimationFrame(() => {
        panelRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }

    const appliedButtons = workingButtons.map((button) => ({
      text: button.text.trim(),
      url: button.url.trim(),
    }));
    setWorkingButtons(createWorkingButtons(appliedButtons));
    setTouchedFields([]);
    onApply(appliedButtons);
  }, [disabled, onApply, workingButtons]);

  useNativeBackHandler(
    () => {
      discard();
      return true;
    },
    { enabled: open, priority: 690 },
  );

  useEffect(() => {
    if (!open || typeof document === 'undefined') {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.classList.add('publication-buttons-sheet-open');
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      document.body.classList.remove('publication-buttons-sheet-open');
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      discard();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [discard, open]);

  function updateButton(index: number, patch: Partial<BroadcastLinkButton>) {
    setWorkingButtons((current) =>
      current.map((button, buttonIndex) =>
        buttonIndex === index ? { ...button, ...patch } : button,
      ),
    );
  }

  function touchField(index: number, field: keyof TouchedButtonFields) {
    setTouchedFields((current) => {
      const next = current.slice();
      next[index] = { ...next[index], [field]: true };
      return next;
    });
  }

  function removeButton(index: number) {
    setWorkingButtons((current) => current.filter((_, buttonIndex) => buttonIndex !== index));
    setTouchedFields((current) => current.filter((_, buttonIndex) => buttonIndex !== index));
  }

  function addButton() {
    if (workingButtons.length >= MAX_PUBLICATION_BUTTONS) {
      return;
    }
    const nextIndex = workingButtons.length;
    setWorkingButtons((current) => [...current, createEmptyBroadcastLinkButton()]);
    setTouchedFields((current) => [...current, {}]);
    window.setTimeout(() => {
      textInputRefs.current[nextIndex]?.focus();
      textInputRefs.current[nextIndex]?.select();
    }, 80);
  }

  const portalTarget = open ? resolvePublicationButtonsPortalTarget() : null;
  if (!open || !portalTarget) {
    return null;
  }

  return createPortal(
    <div className="publication-buttons-sheet">
      <button
        type="button"
        className="publication-buttons-sheet__backdrop"
        aria-label="Закрыть"
        onClick={discard}
        tabIndex={-1}
      />

      <section
        ref={panelRef}
        className="publication-buttons-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-buttons-sheet-title"
        tabIndex={-1}
      >
        <div className="publication-buttons-sheet__grabber" aria-hidden />

        <header className="publication-buttons-sheet__header">
          <strong id="publication-buttons-sheet-title">Кнопки</strong>
          <span>
            {workingButtons.length}/{MAX_PUBLICATION_BUTTONS}
          </span>
          <button ref={closeButtonRef} type="button" onClick={discard} aria-label="Закрыть">
            <IconoirXmark aria-hidden focusable="false" />
          </button>
        </header>

        <div className="publication-buttons-sheet__body">
          <div className="publication-buttons-sheet__editor">
            <div className="publication-buttons-sheet__stack">
              {workingButtons.map((button, index) => {
                const error = visibleErrors[index] ?? {};
                const textErrorId = `${fieldId}-text-${index}`;
                const urlErrorId = `${fieldId}-url-${index}`;
                return (
                  <article className="publication-buttons-sheet__card" key={`button-${index}`}>
                    <div className="publication-buttons-sheet__card-top">
                      <span className="publication-buttons-sheet__badge">
                        {workingButtons.length === 1 ? 'Кнопка' : index + 1}
                      </span>
                      <strong>{button.text.trim() || 'Открыть'}</strong>
                      <button
                        type="button"
                        className="publication-buttons-sheet__remove"
                        onClick={() => removeButton(index)}
                        disabled={disabled}
                        aria-label={`Убрать кнопку ${index + 1}`}
                        title="Убрать"
                      >
                        <IconoirXmark aria-hidden focusable="false" />
                      </button>
                    </div>

                    <label className="publication-buttons-sheet__field">
                      <span>Название</span>
                      <input
                        ref={(input) => {
                          textInputRefs.current[index] = input;
                        }}
                        type="text"
                        maxLength={32}
                        value={button.text}
                        onChange={(event) =>
                          updateButton(index, { text: event.currentTarget.value })
                        }
                        onBlur={() => touchField(index, 'text')}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                            return;
                          }
                          event.preventDefault();
                          urlInputRefs.current[index]?.focus();
                        }}
                        placeholder="Открыть"
                        disabled={disabled}
                        enterKeyHint="next"
                        aria-label={index === 0 ? 'Название' : `Название кнопки ${index + 1}`}
                        aria-invalid={Boolean(error.text) || undefined}
                        aria-describedby={error.text ? textErrorId : undefined}
                      />
                      {error.text ? (
                        <small id={textErrorId} role="alert">
                          {error.text}
                        </small>
                      ) : null}
                    </label>

                    <label className="publication-buttons-sheet__field">
                      <span>Ссылка</span>
                      <input
                        ref={(input) => {
                          urlInputRefs.current[index] = input;
                        }}
                        type="url"
                        inputMode="url"
                        maxLength={2048}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={button.url}
                        onChange={(event) =>
                          updateButton(index, { url: event.currentTarget.value })
                        }
                        onBlur={() => touchField(index, 'url')}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
                            return;
                          }
                          event.preventDefault();
                          const nextTextInput = textInputRefs.current[index + 1];
                          if (nextTextInput) {
                            nextTextInput.focus();
                          } else {
                            apply();
                          }
                        }}
                        placeholder="https://..."
                        disabled={disabled}
                        enterKeyHint={index === workingButtons.length - 1 ? 'done' : 'next'}
                        aria-label={index === 0 ? 'Ссылка' : `Ссылка кнопки ${index + 1}`}
                        aria-invalid={Boolean(error.url) || undefined}
                        aria-describedby={error.url ? urlErrorId : undefined}
                      />
                      {error.url ? (
                        <small id={urlErrorId} role="alert">
                          {error.url}
                        </small>
                      ) : null}
                    </label>
                  </article>
                );
              })}
            </div>

            {workingButtons.length < MAX_PUBLICATION_BUTTONS ? (
              <button
                type="button"
                className="publication-buttons-sheet__add"
                onClick={addButton}
                disabled={disabled}
              >
                <span>
                  <IconoirPlus aria-hidden focusable="false" />
                </span>
                <strong>{workingButtons.length === 0 ? 'Добавить' : 'Ещё'}</strong>
              </button>
            ) : null}
          </div>
        </div>

        <footer className="publication-buttons-sheet__footer">
          <button
            type="button"
            className="publication-buttons-sheet__done"
            onClick={apply}
            disabled={disabled}
          >
            Готово
          </button>
        </footer>
      </section>
    </div>,
    portalTarget,
  );
}

export default PublicationButtonsSheet;
