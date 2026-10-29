import { useState, type ReactNode } from 'react';
import { SettingsDrilldownPanel } from '../../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../../components/ui/settings-section-toggle';
export default function ShopPublicationsEntry({
  children,
  dirty,
  discard,
  footer,
}: {
  children: ReactNode;
  dirty?: boolean;
  discard?: () => void;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsSectionToggle
        title="Публикации"
        icon="send"
        tone="sky"
        open={open}
        controls="karavan-publications"
        onClick={() => setOpen(true)}
      />
      <SettingsDrilldownPanel
        id="karavan-publications"
        title="Публикации"
        className="settings-storefront-panel"
        open={open}
        onClose={() => setOpen(false)}
        confirmCloseWhen={dirty}
        onDiscardChanges={discard}
        footer={dirty ? footer : null}
      >
        {children}
      </SettingsDrilldownPanel>
    </>
  );
}
