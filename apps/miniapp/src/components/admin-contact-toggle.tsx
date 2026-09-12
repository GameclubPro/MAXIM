import { NavArrowRight } from 'iconoir-react';
import { lazy, Suspense, useCallback, useState } from 'react';
import { getAdminContactLabel } from '../lib/admin-contact-profile-url';
import type { ApiTransport } from '../lib/api/transport';
import { cn } from '../lib/cn';

const LazyAdminContactPicker = lazy(() =>
  import('./admin-contact-picker').then((module) => ({
    default: module.AdminContactPicker,
  })),
);

type AdminContactToggleProps = {
  api: ApiTransport;
  chatId: string;
  title: string;
  checked: boolean;
  url: string;
  onChange: (enabled: boolean, url: string) => void;
  ariaLabel: string;
  meta?: string;
  nested?: boolean;
  className?: string;
};

export default function AdminContactToggle({
  api,
  chatId,
  title,
  checked,
  url,
  onChange,
  ariaLabel,
  meta,
  nested = false,
  className,
}: AdminContactToggleProps) {
  const [open, setOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<{ url: string; name: string } | null>(
    null,
  );
  const close = useCallback(() => setOpen(false), []);
  const selectedName =
    (selectedContact?.url === url ? selectedContact.name : null) ?? getAdminContactLabel(url);
  return (
    <div
      className={cn(
        'settings-native-toggle',
        nested && 'settings-native-toggle--nested',
        className,
      )}
    >
      <div className="settings-native-toggle__row">
        {meta ? (
          <div className="settings-native-toggle__title-wrap">
            <div className="rules-native-card__copy">
              <span className="settings-native-toggle__title">{title}</span>
              <span className="rules-native-card__meta">{meta}</span>
            </div>
          </div>
        ) : (
          <span className="settings-native-toggle__title">{title}</span>
        )}
        <label className="settings-native-switch" aria-label={ariaLabel}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => (event.target.checked ? setOpen(true) : onChange(false, ''))}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {checked ? (
        <button
          type="button"
          className="admin-contact-selection"
          onClick={() => setOpen(true)}
          aria-label={`Выбрать администратора: ${selectedName}`}
          aria-haspopup="dialog"
        >
          <span>{selectedName}</span>
          <NavArrowRight aria-hidden />
        </button>
      ) : null}
      {open ? (
        <Suspense fallback={<p role="status">Загрузка администраторов...</p>}>
          <LazyAdminContactPicker
            api={api}
            chatId={chatId}
            checked={checked}
            url={url}
            onClose={close}
            onSelect={(contactUrl, name) => {
              setSelectedContact({ url: contactUrl, name });
              onChange(true, contactUrl);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
