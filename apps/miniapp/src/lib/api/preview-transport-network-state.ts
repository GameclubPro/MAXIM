import type { ChatSummary, ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type { PreviewState } from './preview-transport-state';

const initialized = new WeakSet<PreviewState>();
function initialize(state: PreviewState): void {
  if (initialized.has(state)) return;
  initialized.add(state);
  if (!state.me.networksEnabled) return;
  for (const entityType of ['chat', 'channel'] as const) {
    const rows = entityType === 'chat' ? state.chats : state.channels;
    const sample = rows[0];
    if (!sample) continue;
    const count = state.networksScenario === 'large' ? 520 : 104;
    for (let index = 0; index < count; index += 1) {
      const category: ManagedEntityFavoriteType | null =
        index < (count === 520 ? 512 : 62)
          ? 'important'
          : index < count - 15
            ? 'watch'
            : index < count - 5
              ? 'partner'
              : null;
      rows.push({
        ...structuredClone(sample),
        id: `preview-network-${entityType}-${String(index + 1).padStart(4, '0')}`,
        title:
          index === 0
            ? 'Очень длинное название сообщества — новости, обсуждения и важные объявления нашего района'
            : `${entityType === 'chat' ? 'Районный чат' : 'Городской канал'} ${index + 1}`,
        avatarUrl: null,
        favoriteTypes: category ? [category] : [],
      });
    }
  }
}
export function getPreviewNetworkEntities(
  state: PreviewState,
  type: ManagedEntityType,
): ChatSummary[] {
  initialize(state);
  return type === 'chat' ? state.chats : state.channels;
}
export function getPreviewNetworkVersion(
  state: PreviewState,
  type: ManagedEntityType,
  favoriteType?: ManagedEntityFavoriteType,
): string {
  const rows = getPreviewNetworkEntities(state, type).filter(
    (item) => !favoriteType || item.favoriteTypes?.[0] === favoriteType,
  );
  const identity = rows
    .map((item) => `${item.id}:${item.favoriteTypes?.[0] ?? ''}`)
    .sort()
    .join('|');
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1)
    hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619) >>> 0;
  return `preview-${type}-${favoriteType ?? 'all'}-${hash.toString(16)}`;
}
