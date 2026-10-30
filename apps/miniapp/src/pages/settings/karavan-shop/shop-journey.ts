export function sellerApplicationUrl(
  botUrl: string | undefined,
  marketplaceId: string,
): string | null {
  if (
    !botUrl ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      marketplaceId,
    )
  )
    return null;
  try {
    const url = new URL(botUrl);
    if (
      url.origin !== 'https://max.ru' ||
      url.username ||
      url.password ||
      !/^\/[A-Za-z0-9_]{3,64}\/?$/u.test(url.pathname)
    )
      return null;
    url.search = '';
    url.hash = '';
    url.searchParams.set('startapp', `placement_${marketplaceId}`);
    return url.href;
  } catch {
    return null;
  }
}

export function shopNextAction(input: {
  status: 'active' | 'draft' | 'paused' | 'archived';
  listings: number;
  pendingApplications: number;
  readyListings?: number;
  canManage: boolean;
  canReview: boolean;
}): 'review' | 'sellers' | 'open' | 'invite' | null {
  if (input.status === 'archived') return null;
  if (input.canReview && input.pendingApplications > 0) return 'review';
  if (!input.canManage) return null;
  if (input.listings === 0) return 'invite';
  if (input.status === 'active') return null;
  return input.readyListings !== undefined && input.readyListings > 0 ? 'open' : 'sellers';
}

export function uniqueShopItems<T extends { id: string }>(pages: readonly (readonly T[])[]): T[] {
  return [...new Map(pages.flat().map((item) => [item.id, item])).values()];
}
