import { useState } from 'react';
import { AppIcon } from './ui/app-icon';
import type { ApiTransport } from '../lib/api/transport';
import { BIRZHIK_CATALOG_URL, openMarketplace } from '../lib/marketplace-launch';
import './birzhik-handoff.css';

export default function BirzhikHandoff({ api }: { api: ApiTransport }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="birzhik-handoff">
      <a
        className="birzhik-handoff__link"
        href={BIRZHIK_CATALOG_URL}
        aria-busy={busy || undefined}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setFailed(false);
          void openMarketplace(api, { target: 'catalog' })
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        <AppIcon icon="Shop" aria-hidden />
        <span>Рекламная биржа</span>
        <AppIcon icon="ArrowUpRight" aria-hidden />
      </a>
      {failed && (
        <p role="alert">
          Не удалось открыть Биржик. <a href={BIRZHIK_CATALOG_URL}>Открыть Биржик</a>
        </p>
      )}
    </div>
  );
}
