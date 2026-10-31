import type { ReactNode } from 'react';
import { SettingsSectionToggle } from '../../../components/ui/settings-section-toggle';
import { StorefrontScreen, useStorefrontWorkspace } from '../storefront-workspace';
export default function ShopPublicationsEntry({ children }: { children: ReactNode }) {
  const workspace = useStorefrontWorkspace();
  return (
    <>
      <StorefrontScreen page="home">
        <SettingsSectionToggle
          title="Объявления в чате"
          icon="send"
          tone="sky"
          open={false}
          controls="karavan-publications"
          onClick={() => workspace?.navigate('publications')}
        />
      </StorefrontScreen>
      <StorefrontScreen page="publications">
        <div id="karavan-publications">{children}</div>
      </StorefrontScreen>
    </>
  );
}
