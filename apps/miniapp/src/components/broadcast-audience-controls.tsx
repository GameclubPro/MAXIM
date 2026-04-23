import type { BroadcastTargetMode, ChatSummary } from '@maxim/contracts';
import { useEffect, useState } from 'react';
import {
  resolveBroadcastAudienceTargetLabel,
  type BroadcastScopedTargetMode,
} from '../lib/broadcast-audience';
import { BroadcastAudienceSheet } from './broadcast-audience-sheet';
import { SegmentedControl } from './ui/segmented-control';

type BroadcastAudienceControlsProps = {
  targetMode: BroadcastTargetMode;
  currentChatId: string;
  targetChatIds: string[];
  choices: ChatSummary[];
  loading?: boolean;
  remoteError?: string | null;
  validationError?: string | null;
  disabled?: boolean;
  onToggleAllChats: (enabled: boolean) => void;
  onChangeScopedMode: (mode: BroadcastScopedTargetMode) => void;
  onApplySelection: (nextSelection: string[]) => void;
  onClearValidationError: () => void;
};

export function BroadcastAudienceControls({
  targetMode,
  currentChatId,
  targetChatIds,
  choices,
  loading = false,
  remoteError = null,
  validationError = null,
  disabled = false,
  onToggleAllChats,
  onChangeScopedMode,
  onApplySelection,
  onClearValidationError,
}: BroadcastAudienceControlsProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const scopedTargetMode: BroadcastScopedTargetMode =
    targetMode === 'selected' ? 'selected' : 'current';
  const activeAudienceLabel = resolveBroadcastAudienceTargetLabel({
    targetMode,
    targetChatIds,
    currentLabel: 'Текущий чат',
  });
  const selectedAudienceLabel = resolveBroadcastAudienceTargetLabel({
    targetMode: 'selected',
    targetChatIds,
  });
  const triggerLabel = loading
    ? 'Собираем список'
    : remoteError
      ? 'Обновить список'
      : selectedAudienceLabel;

  useEffect(() => {
    if (targetMode !== 'selected') {
      setSheetOpen(false);
    }
  }, [targetMode]);

  useEffect(() => {
    if (targetMode === 'selected' && validationError) {
      setSheetOpen(true);
    }
  }, [targetMode, validationError]);

  return (
    <>
      <div className="broadcast-audience-card">
        <div className="broadcast-audience-card__toggle">
          <div className="broadcast-audience-card__toggle-copy">
            <strong>Все чаты</strong>
            <span>{activeAudienceLabel}</span>
          </div>

          <label className="settings-native-switch" aria-label="Отправить во все чаты">
            <input
              type="checkbox"
              checked={targetMode === 'all'}
              onChange={(event) => onToggleAllChats(event.target.checked)}
              disabled={disabled}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {targetMode !== 'all' ? (
          <>
            <SegmentedControl
              className="broadcast-scope-control"
              ariaLabel="Охват рассылки"
              value={scopedTargetMode}
              onChange={(value) =>
                onChangeScopedMode(value === 'selected' ? 'selected' : 'current')
              }
              options={[
                { value: 'current', label: 'Текущий' },
                { value: 'selected', label: 'Выбрать' },
              ]}
            />

            {scopedTargetMode === 'selected' ? (
              <button
                type="button"
                className="broadcast-audience-card__trigger"
                onClick={() => {
                  onClearValidationError();
                  setSheetOpen(true);
                }}
                disabled={disabled}
              >
                <span className="broadcast-audience-card__trigger-copy">
                  <strong>Активные чаты</strong>
                  <small>{triggerLabel}</small>
                </span>
                <span className="broadcast-audience-card__trigger-badge">{targetChatIds.length}</span>
              </button>
            ) : null}
          </>
        ) : null}

        {validationError ? <small className="field__hint">{validationError}</small> : null}
      </div>

      <BroadcastAudienceSheet
        open={sheetOpen}
        currentChatId={currentChatId}
        choices={choices}
        selection={targetChatIds}
        disabled={disabled}
        loading={loading}
        error={remoteError}
        onClose={() => setSheetOpen(false)}
        onApply={(nextSelection) => {
          onApplySelection(nextSelection);
          setSheetOpen(false);
        }}
      />
    </>
  );
}
