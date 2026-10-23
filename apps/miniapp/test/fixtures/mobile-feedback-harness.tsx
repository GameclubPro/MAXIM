import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { ToastProvider, useToast } from '../../src/components/ui/toast';
import { useDialogFocusTrap } from '../../src/lib/dialog-focus';
import '../../src/styles.css';

function Feedback() {
  const { pushToast } = useToast();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(open, panel, first);
  return (
    <>
      <input aria-label="Поле" />
      <button
        onClick={() =>
          pushToast({
            tone: 'danger',
            title: 'Не удалось сохранить',
            description: 'Введённые данные сохранены. Повторите действие.',
          })
        }
      >
        Ошибка
      </button>
      <button onClick={() => pushToast({ title: 'Готово', durationMs: 500 })}>Успех</button>
      <button onClick={() => setOpen(true)}>Диалог</button>
      {open ? (
        <div ref={panel} role="dialog" aria-modal="true" aria-label="Проверка фокуса" tabIndex={-1}>
          <button tabIndex={-1}>Программный фокус</button>
          <button ref={first}>Первый</button>
          <div inert>
            <button>Неактивный</button>
          </div>
          <button style={{ visibility: 'hidden' }}>Невидимый</button>
          <button onClick={() => setOpen(false)}>Закрыть</button>
          <button tabIndex={-1}>Последний вне Tab</button>
        </div>
      ) : null}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <Feedback />
  </ToastProvider>,
);
