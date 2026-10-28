import { useState } from 'react';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import { SettingsSectionIcon } from './ui/settings-section-toggle';
import MarketplaceEntryWorkspace from './marketplace-entry-workspace';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

export default function MarketplaceProfilePanel({
  id,
  onClose,
  ...props
}: MarketplaceProfileCardProps & { id: string; onClose: () => void }) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <SettingsDrilldownPanel
      id={id}
      icon={props.profile === 'moderation' ? <SettingsSectionIcon name="ads" /> : undefined}
      open
      title="Биржик"
      tone={props.profile === 'moderation' ? 'amber' : undefined}
      variant="screen"
      overlayClassName="marketplace-profile-overlay"
      onClose={onClose}
      confirmCloseWhen={dirty}
      closeDisabled={busy}
    >
      <MarketplaceEntryWorkspace {...props} onDirtyChange={setDirty} onBusyChange={setBusy} />
    </SettingsDrilldownPanel>
  );
}
