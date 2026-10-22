import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type { NetworkSettingsTarget } from '@maxim/contracts/network-settings';
import { AppIcon } from '../../components/ui/app-icon';
import type { AppIconName } from '../../components/ui/app-icon-names';

export const networkCategoryIcons: Record<ManagedEntityFavoriteType, AppIconName> = {
  important: 'Star',
  watch: 'ShieldCheck',
  broadcast: 'SendDiagonal',
  test: 'Flask',
  partner: 'Group',
  service: 'Wrench',
};
const plural = new Intl.PluralRules('ru-RU');
const number = new Intl.NumberFormat('ru-RU');
export function formatNetworkEntityCount(count: number, type: ManagedEntityType): string {
  const form = plural.select(count);
  const names = type === 'chat' ? ['чат', 'чата', 'чатов'] : ['канал', 'канала', 'каналов'];
  return `${number.format(count)} ${names[form === 'one' ? 0 : form === 'few' ? 1 : 2]}`;
}
export function NetworkScopeBadge({
  title,
  entityType,
  target,
  count,
}: {
  title: string;
  entityType: ManagedEntityType;
  target: NetworkSettingsTarget;
  count?: number;
}) {
  return (
    <div
      className="network-settings-scope"
      data-network-category={target.mode === 'category' ? target.favoriteType : undefined}
    >
      <AppIcon
        icon={target.mode === 'category' ? networkCategoryIcons[target.favoriteType] : 'Group'}
      />
      <span>
        <strong>{title}</strong>
        {count !== undefined ? <small>{formatNetworkEntityCount(count, entityType)}</small> : null}
      </span>
      <b>{target.mode === 'category' ? 'Вся сетка' : 'Выбранные'}</b>
    </div>
  );
}
