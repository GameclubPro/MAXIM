import { useLayoutEffect, useRef, useState } from 'react';
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
  const restoreFocus = useRef(false);
  const openScreen = (next: MarketplaceScreen, source?: HTMLElement) => {
    opener.current =
      source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openerAction.current = opener.current?.dataset.marketplaceAction ?? null;
    setScreen(next);
  };
  const closeScreen = () => {
    if (screen === 'overview') {
      onClose();
      return;
    }
    restoreFocus.current = true;
    setDirty(false);
    setScreen('overview');
  };
  // FLAG: Native Back runs outside React events. Restore focus only after the
  // destination is committed, never in a frame that can beat the new DOM.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const panel = document.getElementById(`${id}-title`)?.closest<HTMLElement>('[role="dialog"]');
      if (screen !== 'overview') {
        panel?.focus();
        const content = panel?.querySelector('.settings-drilldown__content');
        if (content) content.scrollTop = 0;
      } else if (restoreFocus.current) {
        restoreFocus.current = false;
        const restored = opener.current?.isConnected
          ? opener.current
          : [...(panel?.querySelectorAll<HTMLElement>('[data-marketplace-action]') ?? [])].find(
              (element) => element.dataset.marketplaceAction === openerAction.current,
            );
        if (restored?.getClientRects().length) restored.focus();
        else panel?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [screen, id]);
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
