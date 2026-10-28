import { useRef, useState } from 'react';
import './marketplace-profile-panel.css';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import { SettingsSectionIcon } from './ui/settings-section-toggle';
import MarketplaceEntryWorkspace from './marketplace-entry-workspace';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

type PanelProps = MarketplaceProfileCardProps & { id: string; onClose: () => void };
export type MarketplaceScreen = 'overview' | 'profile' | 'buttons';

export default function MarketplaceProfilePanel(props: PanelProps) {
  return (
    <MarketplacePanelContents
      key={`${props.profile}:${props.entityType}:${props.entityId}`}
      {...props}
    />
  );
}

function MarketplacePanelContents({ id, onClose, ...props }: PanelProps) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<MarketplaceScreen>('overview');
  const opener = useRef<HTMLElement | null>(null);
  const openerAction = useRef<string | null>(null);
  const openScreen = (next: MarketplaceScreen, source?: HTMLElement) => {
    opener.current =
      source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openerAction.current = opener.current?.dataset.marketplaceAction ?? null;
    setScreen(next);
    requestAnimationFrame(() => {
      document.getElementById(`${id}-title`)?.closest<HTMLElement>('[role="dialog"]')?.focus();
      const content = document.querySelector(
        '.marketplace-profile-overlay .settings-drilldown__content',
      );
      if (content) content.scrollTop = 0;
    });
  };
  const closeScreen = () => {
    if (screen === 'overview') {
      onClose();
      return;
    }
    setDirty(false);
    setScreen('overview');
    requestAnimationFrame(() => {
      const restored = opener.current?.isConnected
        ? opener.current
        : [
            ...document.querySelectorAll<HTMLElement>(
              '.marketplace-profile-overlay [data-marketplace-action]',
            ),
          ].find((element) => element.dataset.marketplaceAction === openerAction.current);
      if (restored?.getClientRects().length) restored.focus();
      else
        document
          .querySelector<HTMLElement>(
            '.marketplace-profile-overlay .marketplace-entry__overview button',
          )
          ?.focus();
    });
  };
  const title = { overview: 'Рекламная биржа', profile: 'Профиль', buttons: 'Кнопка в сообщениях' }[
    screen
  ];
  return (
    <SettingsDrilldownPanel
      id={id}
      icon={props.profile === 'moderation' ? <SettingsSectionIcon name="ads" /> : undefined}
      open
      title={title}
      tone={props.profile === 'moderation' ? 'sky' : undefined}
      variant="screen"
      overlayClassName="marketplace-profile-overlay"
      onClose={closeScreen}
      confirmCloseWhen={dirty}
      closeDisabled={busy}
    >
      <MarketplaceEntryWorkspace
        {...props}
        screen={screen}
        onScreenChange={openScreen}
        onDirtyChange={setDirty}
        onBusyChange={setBusy}
      />
    </SettingsDrilldownPanel>
  );
}
