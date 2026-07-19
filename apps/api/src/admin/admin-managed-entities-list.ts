import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntitiesRefreshState,
  ManagedEntitiesResponseDiff,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  ManagedEntitiesListOptions,
  ManagedEntitiesListResult,
  ManagedEntityTypeFilter,
} from './admin.service.support';

type ManagedEntitiesListValueParams = {
  user: AuthUser;
  entityType: ManagedEntityTypeFilter;
  options?: ManagedEntitiesListOptions;
  listDetailed: (
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: ManagedEntitiesListOptions,
  ) => Promise<ManagedEntitiesListResult>;
  attachFavoriteTypes: (userId: string, items: readonly ChatSummary[]) => Promise<ChatSummary[]>;
};

type ManagedEntitiesListWithRefreshStateValueParams = ManagedEntitiesListValueParams & {
  attachFavoriteTypesToDiff: (
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ) => Promise<ManagedEntitiesResponseDiff | null | undefined>;
  createIdleRefreshState: () => ManagedEntitiesRefreshState;
};

function attachUserVisibleRefreshState(
  refresh: ManagedEntitiesRefreshState,
  options: {
    items: readonly ChatSummary[];
    diff?: ManagedEntitiesResponseDiff | null;
  },
): ManagedEntitiesRefreshState {
  const userVisibleComplete =
    refresh.complete === true || options.items.length > 0 || options.diff != null;
  if (refresh.userVisibleComplete === userVisibleComplete) {
    return refresh;
  }

  return {
    ...refresh,
    userVisibleComplete,
  };
}

export async function listManagedEntitiesValue(
  params: ManagedEntitiesListValueParams,
): Promise<ChatSummary[]> {
  const result = await params.listDetailed(params.user, params.entityType, params.options ?? {});
  return params.attachFavoriteTypes(params.user.userId, result.items);
}

export async function listManagedEntitiesWithRefreshStateValue(
  params: ManagedEntitiesListWithRefreshStateValueParams,
): Promise<ManagedEntitiesListResponse> {
  const result = await params.listDetailed(params.user, params.entityType, {
    ...(params.options ?? {}),
    includeRefreshState: true,
  });
  const refresh = attachUserVisibleRefreshState(result.refresh ?? params.createIdleRefreshState(), {
    items: result.items,
    diff: result.diff,
  });
  const items = await params.attachFavoriteTypes(params.user.userId, result.items);
  const response: ManagedEntitiesListResponse = {
    items,
    refresh,
  };
  if (result.snapshot) {
    response.snapshot = result.snapshot;
  }
  if (result.diff) {
    response.diff = await params.attachFavoriteTypesToDiff(params.user.userId, result.diff);
  }
  return response;
}
