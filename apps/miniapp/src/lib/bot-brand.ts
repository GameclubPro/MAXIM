type BotBrand = { name: string; avatarUrl: string | null };

const MAXIMOV: BotBrand = {
  name: 'Майор Максимов',
  avatarUrl: new URL('../assets/bots/maximov.webp', import.meta.url).href,
};
const MAXIMOVA: BotBrand = {
  name: 'Майор Максимова',
  avatarUrl: new URL('../assets/bots/maximova.webp', import.meta.url).href,
};
const REX: BotBrand = {
  name: 'Рэкс',
  avatarUrl: new URL('../assets/bots/rex.webp', import.meta.url).href,
};
const UNKNOWN: BotBrand = { name: 'Модерация', avatarUrl: null };

export const PUBLIK_BRAND: BotBrand = {
  name: 'Публик',
  avatarUrl: new URL('../assets/bots/publik.webp', import.meta.url).href,
};

const MODERATION_BRANDS: Readonly<Record<string, BotBrand>> = {
  id613070470872_9_bot: MAXIMOV,
  id613002203036_bot: MAXIMOV,
  id613070470872_5_bot: MAXIMOVA,
  id613002203036_4_bot: MAXIMOVA,
  id613070470872_6_bot: REX,
  id613002203036_5_bot: REX,
};

// FLAG: Use the authenticated /me bot link, never a launch-query hint or a chat's assigned bot.
export function resolveModerationBotBrand(botUrl: string | null): BotBrand {
  if (!botUrl) return UNKNOWN;
  try {
    const url = new URL(botUrl);
    if (url.origin !== 'https://max.ru' || url.username || url.password || url.search || url.hash) {
      return UNKNOWN;
    }
    const handle = url.pathname.slice(1);
    return Object.hasOwn(MODERATION_BRANDS, handle) ? MODERATION_BRANDS[handle]! : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}
