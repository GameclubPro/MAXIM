import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import type { BroadcastLinkButton } from '@maxim/contracts';
import { MAX_PUBLICATION_BUTTONS, publicationButtonSchema } from '@maxim/contracts/publication';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  createEmptyBroadcastLinkButton,
  hasBroadcastLinkButtonErrors,
  type BroadcastLinkButtonFieldErrors,
} from '../../lib/broadcast-link-buttons';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { NATIVE_BACK_MODAL_CONFIRM_PRIORITY, useNativeBackHandler } from '../../lib/native-back';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
import { havePublicationButtonsChanged } from './publication-buttons-working-copy';
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
  const openingButtonsRef = useRef(createWorkingButtons(buttons));
  const discardPanelRef = useRef<HTMLElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const fieldId = useId();
  const [workingButtons, setWorkingButtons] = useState(() => createWorkingButtons(buttons));
  const [touchedFields, setTouchedFields] = useState<TouchedButtonFields[]>([]);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const overlayStyle = useVisualViewportOverlayStyle(open);
  const validationErrors = validatePublicationButtons(workingButtons);
  const visibleErrors = revealTouchedErrors(validationErrors, touchedFields);

  useDialogFocusTrap(open, panelRef, closeButtonRef);
  useDialogFocusTrap(open && discardConfirmationOpen, discardPanelRef, keepEditingRef);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const openingButtons = createWorkingButtons(buttons);
      openingButtonsRef.current = openingButtons;
      setWorkingButtons(openingButtons);
      setTouchedFields([]);
      setDiscardConfirmationOpen(false);
    }
    wasOpenRef.current = open;
  }, [buttons, open]);

  useEffect(() => {
    if (!open || workingButtons.length === 0) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (panelRef.current?.contains(activeElement) && activeElement !== closeButtonRef.current) {
        return;
      }
      textInputRefs.current[0]?.focus();
      textInputRefs.current[0]?.select();
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, [open]);

  useEffect(() => {
    if (!open || discardConfirmationOpen) {
      return undefined;
    }
    const panel = panelRef.current;
    let frame = 0;
    const revealFocusedInput = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const active = document.activeElement;
        const body = panel?.querySelector<HTMLElement>('.publication-buttons-sheet__body');
        if (!(active instanceof HTMLInputElement) || !body?.contains(active)) {
          return;
        }
        const fieldRect = active.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        if (fieldRect.bottom > bodyRect.bottom - 4) {
          body.scrollTop += fieldRect.bottom - bodyRect.bottom + 4;
        } else if (fieldRect.top < bodyRect.top + 4) {
          body.scrollTop -= bodyRect.top - fieldRect.top + 4;
        }
      });
    };
    revealFocusedInput();
    panel?.addEventListener('focusin', revealFocusedInput);
    return () => {
      window.cancelAnimationFrame(frame);
      panel?.removeEventListener('focusin', revealFocusedInput);
    };
  }, [discardConfirmationOpen, open, overlayStyle]);

  const discard = useCallback(() => {
    setWorkingButtons(createWorkingButtons(buttons));
    setTouchedFields([]);
    setDiscardConfirmationOpen(false);
    onClose();
  }, [buttons, onClose]);

  const requestClose = useCallback(() => {
    if (havePublicationButtonsChanged(openingButtonsRef.current, workingButtons)) {
      setDiscardConfirmationOpen(true);
      return;
    }
    discard();
  }, [discard, workingButtons]);

  const apply = useCallback(() => {
    if (disabled) {
      return;
    }
    setDiscardConfirmationOpen(false);
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
      requestClose();
      return true;
    },
    { enabled: open, priority: 690 },
  );
  useNativeBackHandler(
    () => {
      setDiscardConfirmationOpen(false);
      return true;
    },
    { enabled: open && discardConfirmationOpen, priority: NATIVE_BACK_MODAL_CONFIRM_PRIORITY },
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
      const activePanel = discardConfirmationOpen ? discardPanelRef.current : panelRef.current;
      if (!activePanel || !isTopmostModalDialog(activePanel)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (discardConfirmationOpen) {
        setDiscardConfirmationOpen(false);
      } else {
        requestClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [discardConfirmationOpen, open, requestClose]);

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

  function moveButton(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (disabled || nextIndex < 0 || nextIndex >= workingButtons.length) {
      return;
    }
    setWorkingButtons((current) => {
      const next = current.slice();
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
    setTouchedFields((current) => {
      const next = workingButtons.map((_, buttonIndex) => current[buttonIndex] ?? {});
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
    window.requestAnimationFrame(() => textInputRefs.current[nextIndex]?.focus());
  }

  function addButton() {
    if (workingButtons.length >= MAX_PUBLICATION_BUTTONS) {
      return;
    }
    const nextIndex = workingButtons.length;
    const nextButton = createEmptyBroadcastLinkButton();
    setWorkingButtons((current) => [
      ...current,
      { ...nextButton, text: nextIndex === 0 ? nextButton.text : '' },
    ]);
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
    <div
      className={`publication-buttons-sheet${typeof overlayStyle?.height === 'number' && overlayStyle.height <= 360 ? ' is-compact-viewport' : ''}`}
      style={overlayStyle}
    >
      <button
        type="button"
        className="publication-buttons-sheet__backdrop"
        aria-label="Закрыть"
        onClick={requestClose}
        tabIndex={-1}
      />

      <section
        ref={panelRef}
        className="publication-buttons-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-buttons-sheet-title"
        aria-hidden={discardConfirmationOpen || undefined}
        inert={discardConfirmationOpen}
        tabIndex={-1}
      >
        <header className="publication-buttons-sheet__header">
          <strong id="publication-buttons-sheet-title">Кнопки</strong>
          <span>
            {workingButtons.length}/{MAX_PUBLICATION_BUTTONS}
          </span>
          <button ref={closeButtonRef} type="button" onClick={requestClose} aria-label="Закрыть">
            <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden focusable="false" />
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
                      <strong>{button.text.trim() || `Кнопка ${index + 1}`}</strong>
                      <button
                        type="button"
                        className="publication-buttons-sheet__remove"
                        onClick={() => removeButton(index)}
                        disabled={disabled}
                        aria-label={`Убрать кнопку ${index + 1}`}
                        title="Убрать"
                      >
                        <IconoirSprite
                          variant="iconoir"
                          icon="Xmark"
                          aria-hidden
                          focusable="false"
                        />
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
                        placeholder={index === 0 ? 'Открыть' : 'Название кнопки'}
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
                    {workingButtons.length > 1 ? (
                      <div className="publication-buttons-sheet__order">
                        <span>Порядок: {index + 1}</span>
                        <button
                          type="button"
                          onClick={() => moveButton(index, -1)}
                          disabled={disabled || index === 0}
                          aria-label={`Переместить кнопку ${index + 1} выше`}
                        >
                          <IconoirSprite variant="iconoir" icon="NavArrowUp" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveButton(index, 1)}
                          disabled={disabled || index === workingButtons.length - 1}
                          aria-label={`Переместить кнопку ${index + 1} ниже`}
                        >
                          <IconoirSprite variant="iconoir" icon="NavArrowDown" aria-hidden />
                        </button>
                      </div>
                    ) : null}
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
                  <IconoirSprite variant="iconoir" icon="Plus" aria-hidden focusable="false" />
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
      {discardConfirmationOpen ? (
        <div className="publication-buttons-sheet__discard">
          <button
            type="button"
            className="publication-buttons-sheet__backdrop"
            aria-label="Продолжить редактирование"
            tabIndex={-1}
            onClick={() => setDiscardConfirmationOpen(false)}
          />
          <section
            ref={discardPanelRef}
            className="publication-buttons-sheet__discard-panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${fieldId}-discard-title`}
            aria-describedby={`${fieldId}-discard-description`}
            tabIndex={-1}
          >
            <strong id={`${fieldId}-discard-title`}>Закрыть без сохранения?</strong>
            <p id={`${fieldId}-discard-description`}>
              Изменения кнопок будут потеряны. Чтобы сохранить их, вернитесь и нажмите «Готово».
            </p>
            <button
              ref={keepEditingRef}
              type="button"
              onClick={() => setDiscardConfirmationOpen(false)}
            >
              Продолжить редактирование
            </button>
            <button type="button" className="is-danger" onClick={discard}>
              Не сохранять
            </button>
          </section>
        </div>
      ) : null}
    </div>,
    portalTarget,
  );
}

export default PublicationButtonsSheet;
