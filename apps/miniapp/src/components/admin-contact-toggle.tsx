import { lazy, Suspense, useCallback, useState } from 'react';
import { getAdminContactLabel } from '../lib/admin-contact-profile-url';
import type { ApiTransport } from '../lib/api/transport';
import { AdminContactToggleField } from './admin-contact-toggle-field';

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
    <AdminContactToggleField
      title={title}
      checked={checked}
      selectedName={selectedName}
      onChange={(enabled) => (enabled ? setOpen(true) : onChange(false, ''))}
      onOpen={() => setOpen(true)}
      ariaLabel={ariaLabel}
      meta={meta}
      nested={nested}
      className={className}
    >
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
    </AdminContactToggleField>
  );
}
