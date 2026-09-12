import '../../src/styles.css';
import {
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
} from '@maxim/contracts/giveaway';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { GiveawayPage } from '../../src/pages/giveaway-page';
import type { ApiTransport } from '../../src/lib/api/transport';

const now = Date.now();
const data = managedGiveawayPublicSchema.parse({
  id: 'browser-test',
  serverTime: new Date(now).toISOString(),
  sourceChatId: 'source',
  sourceTitle: 'Канал организатора',
  sourceLink: 'https://max.ru/source',
  entityType: 'channel',
  title: 'Не дублировать приз',
  description: 'Не дублировать описание',
  status: 'ACTIVE',
  imageEnabled: false,
  imageBase64: '',
  imageMimeType: '',
  imageFileName: '',
  startsAt: null,
  endsAt: new Date(now + 3_600_000).toISOString(),
  claimHours: 24,
  requiredChannelIds: ['extra'],
  requiredChannels: [{ id: 'extra', title: 'Партнёр', link: 'https://max.ru/extra' }],
  entriesCount: 1234,
  winnersCount: 0,
  publishedAt: new Date(now).toISOString(),
  completedAt: null,
  publicationUrl: 'https://max.ru/post',
  resultsUrl: null,
  prizes: [{ id: 'prize', position: 1, title: 'Скрытый приз', displayTitle: 'Скрытый приз' }],
  winners: [],
});
let participant = managedGiveawayParticipantStateSchema.parse({
  joined: false,
  checkedAt: null,
  entryId: null,
  eligibilityState: null,
  eligibilityReason: null,
  missingChannelIds: [],
  joinedAt: null,
  isWinner: false,
  winnerId: null,
  winnerStatus: null,
  claimDeadlineAt: null,
  prizePosition: null,
  prizeTitle: null,
  prizeDisplayTitle: null,
  canClaim: false,
  claimBotUrl: null,
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const fixture = {
  enters: 0,
  claims: 0,
  mode: 'verified',
  opened: false,
  openedUrl: '',
  longConditions() {
    data.sourceTitle = 'Канал организатора с очень длинным названием для проверки переноса строк';
    data.requiredChannels = Array.from({ length: 20 }, (_, index) => ({
      id: `extra-${index}`,
      title: `Дополнительный канал ${index + 1} с очень длинным названием`,
      link: `https://max.ru/extra-${index}`,
    }));
    data.requiredChannelIds = data.requiredChannels.map((channel) => channel.id);
    void client.invalidateQueries();
  },
  refresh() {
    void client.invalidateQueries();
  },
  setScenario(scenario: string) {
    data.status =
      scenario === 'scheduled'
        ? 'SCHEDULED'
        : scenario === 'drawing'
          ? 'DRAWING'
          : scenario === 'canceled'
            ? 'CANCELED'
            : 'COMPLETED';
    if (scenario === 'scheduled') data.startsAt = new Date(Date.now() + 60_000).toISOString();
    if (scenario === 'winner' || scenario === 'expired') {
      participant = {
        ...participant,
        isWinner: true,
        winnerId: 'winner',
        winnerStatus: 'SELECTED',
        canClaim: true,
        prizePosition: 1,
        claimDeadlineAt: new Date(
          Date.now() + (scenario === 'expired' ? -1_000 : 3_600_000),
        ).toISOString(),
      };
      data.resultsUrl = 'https://max.ru/results';
      data.winners = [
        {
          prizePosition: 1,
          prizeTitle: 'Скрытый приз',
          prizeDisplayTitle: 'Скрытый приз',
          displayName: 'Победитель с длинным именем',
          status: scenario === 'expired' ? 'EXPIRED' : 'SELECTED',
        },
      ];
    }
    void client.invalidateQueries();
  },
};
Object.assign(window, {
  giveawayTest: fixture,
  WebApp: {
    openMaxLink: (url: string) => {
      fixture.opened = true;
      fixture.openedUrl = url;
    },
  },
});
const api = {
  async request(path: string) {
    if (path.endsWith('/enter')) {
      fixture.enters += 1;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      if (fixture.mode === 'error') throw new Error('Проверка временно недоступна');
      participant = {
        ...participant,
        joined: true,
        entryId: 'ticket-123',
        joinedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        eligibilityState:
          fixture.mode === 'missing'
            ? 'REJECTED'
            : fixture.mode === 'pending'
              ? 'PENDING'
              : 'VERIFIED',
        missingChannelIds: fixture.mode === 'missing' ? ['extra'] : [],
      };
      return { ...participant };
    }
    if (path.endsWith('/claim')) {
      fixture.claims += 1;
      participant = { ...participant, winnerStatus: 'CLAIMED', canClaim: false };
      return {
        ok: true,
        winner: {
          id: 'winner',
          prizeId: 'prize',
          prizePosition: 1,
          prizeTitle: 'Скрытый приз',
          prizeDisplayTitle: 'Скрытый приз',
          entryId: participant.entryId,
          userId: 'test-user',
          displayName: 'Участник',
          status: 'CLAIMED',
          selectedAt: new Date(now).toISOString(),
          claimDeadlineAt: participant.claimDeadlineAt,
          claimedAt: new Date().toISOString(),
          deliveredAt: null,
          expiredAt: null,
          rerolledAt: null,
        },
      };
    }
    if (path.endsWith('/me')) {
      if (fixture.mode === 'read-error') throw new Error('Статус временно недоступен');
      return { ...participant };
    }
    if (fixture.mode === 'public-error') throw new Error('Розыгрыш временно недоступен');
    return { ...data, serverTime: new Date().toISOString() };
  },
} as ApiTransport;
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/giveaways/browser-test']}>
      <Routes>
        <Route path="/giveaways/:giveawayId" element={<GiveawayPage api={api} />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
