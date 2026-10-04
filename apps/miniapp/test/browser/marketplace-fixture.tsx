import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';
import '../../src/styles/publisher-workspace.css';
import '../../src/components/marketplace-profile-card.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import MarketplaceProfilePanel from '../../src/components/marketplace-profile-panel';
import { ApiRequestError } from '../../src/lib/api-request-error';
import type { ApiTransport } from '../../src/lib/api/transport';

const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const api: ApiTransport = {
  request: async (_path, init) => {
    const response = await fetch('/app/__marketplace-fixture', init);
    if (!response.ok)
      throw new ApiRequestError(response.status, await response.text(), 'Fixture request failed');
    return response.json();
  },
  requestKeepalive: () => undefined,
};
const params = new URLSearchParams(location.search);
const profile = params.get('profile') === 'moderation' ? 'moderation' : 'publisher';
const kind = params.get('kind') === 'chat' ? 'chat' : 'channel';
document.body.dataset.miniappProfile = profile;
document.documentElement.dataset.maxTheme = params.get('theme') === 'dark' ? 'dark' : 'light';
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={client}>
      {open ? (
        <MarketplaceProfilePanel
          api={api}
          entityId="-100"
          entityType={kind}
          profile={profile}
          id={`marketplace-profile-${profile}-${kind}`}
          onClose={() => setOpen(false)}
        />
      ) : (
        <button onClick={() => setOpen(true)}>Открыть снова</button>
      )}
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
