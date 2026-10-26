import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionConfirmSheet } from '../../src/components/ui/action-confirm-sheet';
import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';
import '../../src/styles/publisher-workspace.css';

function ConfirmSheetHarness() {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Открыть подтверждение
      </button>
      <output aria-label="Результат">{confirmed ? 'Подтверждено' : 'Ожидает'}</output>
      <ActionConfirmSheet
        id="viewport-confirm"
        open={open}
        title="Не сохранять изменения?"
        summary={'Изменения в этом разделе будут отменены. '.repeat(8)}
        previewTitle={'ОченьДлинноеНазваниеБезПробелов'.repeat(14)}
        previewMeta={'https://example.com/'.repeat(12)}
        cancelLabel="Продолжить настройку"
        confirmLabel="Не сохранять"
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setConfirmed(true);
          setOpen(false);
        }}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<ConfirmSheetHarness />);
