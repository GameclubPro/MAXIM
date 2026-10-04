import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import MarketplaceProfileWorkspace from './marketplace-profile-workspace';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

export default function MarketplaceProfilePanel({
  id,
  onClose,
  ...props
}: MarketplaceProfileCardProps & { id: string; onClose: () => void }) {
  return (
    <SettingsDrilldownPanel
      id={id}
      open
      title="Профиль на бирже"
      variant="screen"
      overlayClassName="marketplace-profile-overlay"
      onClose={onClose}
    >
      <MarketplaceProfileWorkspace {...props} />
    </SettingsDrilldownPanel>
  );
}
