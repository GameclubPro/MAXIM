import { lazy, Suspense, useState } from 'react';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import { SettingsSectionToggle } from '../../../components/ui/settings-section-toggle';
import {
  StorefrontActions,
  useStorefrontDirty,
  useStorefrontWorkspace,
} from '../storefront-workspace';
import { MutationFailure, ShopLoading, useShopMutation } from './runtime';
import { SellerAccessAction, useSellerAccess } from './seller-access';

const Invitations = lazy(() => import('./invitations'));

export default function ShopSettings({ module }: { module: KaravanMarketplaceModule }) {
  const workspace = useStorefrontWorkspace();
  const marketplace = module.marketplace!;
  const canManage = module.permissions.includes('manage_marketplace');
  const access = useSellerAccess();
  const [policy, setPolicy] = useState<typeof marketplace.admissionPolicy | null>(null);
  const mutation = useShopMutation(() => setPolicy(null));
  const value = policy ?? marketplace.admissionPolicy;
  const dirty = value !== marketplace.admissionPolicy;
  useStorefrontDirty('admission', dirty);
  return (
    <>
      <div className="karavan-shop__menu">
        {canManage ? (
          <>
            <SettingsSectionToggle
              title="Оформление"
              icon="spark"
              tone="sky"
              open={false}
              controls="karavan-shop-appearance"
              onClick={() => workspace?.navigate('appearance')}
            />
            <SettingsSectionToggle
              title="Категории и правила"
              icon="tools"
              tone="sky"
              open={false}
              controls="karavan-shop-categories"
              onClick={() => workspace?.navigate('categories')}
            />
          </>
        ) : null}
        {module.permissions.includes('bind_chat') ? (
          <SettingsSectionToggle
            title="Подключённые чаты"
            icon="links"
            tone="sky"
            open={false}
            controls="karavan-shop-chats"
            onClick={() => workspace?.navigate('chats')}
          />
        ) : null}
      </div>
      {canManage ? (
        <fieldset
          className="karavan-module__choices"
          disabled={
            mutation.isPending ||
            mutation.isError ||
            access.sharing ||
            access.mutation.isPending ||
            access.mutation.isError
          }
        >
          <legend>Кто может подать заявку</legend>
          {(
            [
              ['applications', 'Все желающие'],
              ['invitation', 'По приглашению'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="radio"
                name="shop-admission"
                checked={value === key}
                onChange={() => setPolicy(key)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {canManage ? <p>Витрины появляются после вашего одобрения.</p> : null}
      <MutationFailure mutation={mutation} />
      {canManage && !dirty ? <SellerAccessAction /> : null}
      {canManage && value === 'invitation' && marketplace.admissionPolicy === 'invitation' ? (
        <Suspense fallback={<ShopLoading />}>
          <Invitations />
        </Suspense>
      ) : null}
      {canManage && dirty ? (
        <StorefrontActions page="settings">
          <button
            type="button"
            className="karavan-module__primary"
            disabled={mutation.isPending || mutation.isError}
            onClick={() =>
              mutation.mutate({
                operation: 'settings',
                input: {
                  commandId: crypto.randomUUID(),
                  expectedRevision: marketplace.editRevision,
                  admissionPolicy: value,
                },
              })
            }
          >
            Сохранить
          </button>
        </StorefrontActions>
      ) : null}
    </>
  );
}
