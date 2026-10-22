import type { SVGProps } from 'react';
import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type { NetworkSettingsTarget } from '@maxim/contracts/network-settings';
import { AppIcon } from '../../components/ui/app-icon';
import { HOME_ENTITY_FAVORITE_ICONS } from '../../components/ui/compact-icons';

export function NetworkCategoryIcon({
  favoriteType,
  ...props
}: SVGProps<SVGSVGElement> & { favoriteType?: ManagedEntityFavoriteType }) {
  const Icon = favoriteType ? HOME_ENTITY_FAVORITE_ICONS[favoriteType] : null;
  return Icon ? <Icon {...props} /> : <AppIcon icon="Community" {...props} />;
}
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
      <NetworkCategoryIcon
        favoriteType={target.mode === 'category' ? target.favoriteType : undefined}
        aria-hidden
      />
      <span>
        <strong>{title}</strong>
        {count !== undefined ? <small>{formatNetworkEntityCount(count, entityType)}</small> : null}
      </span>
      <b>{target.mode === 'category' ? 'Вся сетка' : 'Выбранные'}</b>
    </div>
  );
}
