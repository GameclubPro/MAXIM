import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { resolveRadioGroupNavigationIndex } from '../../lib/radio-group-navigation';

type AsyncRadioOption<Value extends string> = Readonly<{
  value: Value;
  label: string;
}>;

type AsyncRadioGroupProps<Value extends string> = {
  value: Value;
  options: ReadonlyArray<AsyncRadioOption<Value>>;
  ariaLabel: string;
  className: string;
  disabled: boolean;
  onChange: (value: Value) => Promise<boolean>;
};

export function AsyncRadioGroup<Value extends string>({
  value,
  options,
  ariaLabel,
  className,
  disabled,
  onChange,
}: AsyncRadioGroupProps<Value>) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<Value, HTMLButtonElement>());
  const serverValueRef = useRef(value);
  const selectionPendingRef = useRef(false);
  const focusAfterPendingValueRef = useRef<Value | null>(null);
  const shouldRestoreFocusRef = useRef(false);
  const [selectedValue, setSelectedValue] = useState(value);
  const [isSelectionPending, setIsSelectionPending] = useState(false);
  serverValueRef.current = value;

  useEffect(() => {
    if (!selectionPendingRef.current) {
      setSelectedValue(value);
    }
  }, [value]);

  useEffect(() => {
    const focusValue = focusAfterPendingValueRef.current;
    if (disabled || isSelectionPending || !focusValue) {
      return;
    }

    focusAfterPendingValueRef.current = null;
    const shouldRestoreFocus = shouldRestoreFocusRef.current;
    shouldRestoreFocusRef.current = false;
    const group = groupRef.current;
    const activeElement = document.activeElement;
    if (
      !shouldRestoreFocus ||
      !group ||
      (activeElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement &&
        !group.contains(activeElement))
    ) {
      return;
    }

    optionRefs.current.get(focusValue)?.focus();
  }, [disabled, isSelectionPending]);

  function rollbackSelection(): void {
    const rollbackValue = serverValueRef.current;
    focusAfterPendingValueRef.current = rollbackValue;
    setSelectedValue(rollbackValue);
  }

  async function requestValueChange(nextValue: Value): Promise<void> {
    if (disabled || selectionPendingRef.current || nextValue === selectedValue) {
      return;
    }

    selectionPendingRef.current = true;
    focusAfterPendingValueRef.current = nextValue;
    shouldRestoreFocusRef.current =
      groupRef.current?.contains(document.activeElement) === true;
    setIsSelectionPending(true);
    setSelectedValue(nextValue);
    try {
      if (!(await onChange(nextValue))) {
        rollbackSelection();
      }
    } catch {
      rollbackSelection();
    } finally {
      selectionPendingRef.current = false;
      setIsSelectionPending(false);
    }
  }

  function handleKeyDown(currentValue: Value, key: string): boolean {
    const currentIndex = options.findIndex((option) => option.value === currentValue);
    const nextIndex = resolveRadioGroupNavigationIndex(currentIndex, options.length, key);
    if (nextIndex === null) {
      return false;
    }
    if (disabled || selectionPendingRef.current) {
      return true;
    }

    const nextValue = options[nextIndex]?.value;
    if (!nextValue) {
      return false;
    }

    void requestValueChange(nextValue);
    optionRefs.current.get(nextValue)?.focus();
    return true;
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (
      selectionPendingRef.current &&
      event.relatedTarget instanceof Node &&
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      shouldRestoreFocusRef.current = false;
    }
  }

  return (
    <div
      ref={groupRef}
      className={className}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-busy={isSelectionPending || undefined}
      onBlur={handleBlur}
    >
      {options.map((option) => (
        <button
          key={option.value}
          ref={(element) => {
            if (element) {
              optionRefs.current.set(option.value, element);
            } else {
              optionRefs.current.delete(option.value);
            }
          }}
          type="button"
          role="radio"
          aria-checked={selectedValue === option.value}
          tabIndex={selectedValue === option.value ? 0 : -1}
          className={selectedValue === option.value ? 'is-active' : undefined}
          disabled={disabled || isSelectionPending}
          onClick={() => void requestValueChange(option.value)}
          onKeyDown={(event) => {
            if (handleKeyDown(option.value, event.key)) {
              event.preventDefault();
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
