import { useState } from 'react';
import { StorefrontActions, useStorefrontDirty } from '../storefront-workspace';
import {
  marketplaceAppearanceSchema,
  type MarketplaceAppearance,
} from '@maxim/contracts/karavan-marketplace-management';
import { manageKaravanShop } from '../../../lib/api/karavan-shop-client';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShop,
  useShopMutation,
  useShopQuery,
} from './runtime';
import { describeUserFacingError } from '../../../lib/user-facing-error';
const blockNames = { categories: 'Категории', pinned: 'Закреплённые', sellers: 'Продавцы' };
const accentNames = {
  blue: 'Синий',
  violet: 'Фиолетовый',
  teal: 'Бирюзовый',
  rose: 'Розовый',
  graphite: 'Графит',
};
async function imageData(file: File, cover: boolean): Promise<string> {
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024)
    throw new Error('Выберите изображение до 20 МБ.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = cover ? 1200 : 320;
    canvas.height = cover ? 400 : 320;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось подготовить изображение.');
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      bitmap,
      (canvas.width - bitmap.width * scale) / 2,
      (canvas.height - bitmap.height * scale) / 2,
      bitmap.width * scale,
      bitmap.height * scale,
    );
    const data = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    if (!data || data.length > 700000) throw new Error('Выберите изображение меньшего размера.');
    return data;
  } finally {
    bitmap.close();
  }
}
export default function ShopAppearance({ onView }: { onView?: () => void }) {
  const { api, scope } = useShop();
  const query = useShopQuery<'appearance'>({ operation: 'appearance' });
  const [draft, setDraft] = useState<MarketplaceAppearance | null>(null),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const mutation = useShopMutation((command) => {
    if (command.operation === 'appearance_save') setDraft(null);
  });
  const value = draft ?? query.data?.draft;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(query.data?.draft);
  useStorefrontDirty('appearance', dirty || uploading);
  if (query.isPending) return <ShopLoading />;
  if (query.isError || !value)
    return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  const change = <K extends keyof MarketplaceAppearance>(
    key: K,
    next: MarketplaceAppearance[K],
  ) => {
    setDraft({ ...value, [key]: next });
    setError(null);
  };
  const upload = async (file: File, key: 'logoImageUrl' | 'coverImageUrl') => {
    setUploading(true);
    setError(null);
    try {
      const dataBase64 = await imageData(file, key === 'coverImageUrl');
      const result = await manageKaravanShop<'image'>(api, scope, {
        operation: 'image',
        input: {
          commandId: crypto.randomUUID(),
          fileName: key === 'coverImageUrl' ? 'cover.jpg' : 'logo.jpg',
          mimeType: 'image/jpeg',
          dataBase64,
        },
      });
      setDraft((current) => ({ ...(current ?? value), [key]: result.url }));
    } catch (err) {
      setError(describeUserFacingError(err, 'Не удалось загрузить изображение.'));
    } finally {
      setUploading(false);
    }
  };
  return (
    <>
      <MutationFailure mutation={mutation} />
      {error ? <p role="alert">{error}</p> : null}
      <fieldset className="karavan-shop__form" disabled={mutation.isPending || uploading}>
        <label className="karavan-module__field">
          Название
          <input
            value={value.name}
            maxLength={120}
            onChange={(event) => change('name', event.target.value)}
          />
        </label>
        <div className="karavan-shop__media">
          {(['logoImageUrl', 'coverImageUrl'] as const).map((key) => (
            <div key={key} className={key === 'coverImageUrl' ? 'is-cover' : ''}>
              {value[key] ? (
                <img src={value[key]} alt={key === 'coverImageUrl' ? 'Обложка' : 'Логотип'} />
              ) : null}
              <label className="karavan-shop__upload">
                <span>{key === 'coverImageUrl' ? 'Обложка' : 'Логотип'}</span>
                <input
                  type="file"
                  accept="image/*"
                  aria-label={key === 'coverImageUrl' ? 'Загрузить обложку' : 'Загрузить логотип'}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void upload(file, key);
                  }}
                />
              </label>
              {value[key] ? (
                <button type="button" onClick={() => change(key, null)}>
                  Убрать
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <label className="karavan-module__field">
          Описание
          <textarea
            value={value.description ?? ''}
            maxLength={2000}
            onChange={(event) => change('description', event.target.value || null)}
          />
        </label>
        <fieldset className="karavan-module__choices">
          <legend>Акцент</legend>
          <div className="karavan-shop__accents">
            {(Object.keys(accentNames) as Array<MarketplaceAppearance['accent']>).map((accent) => (
              <button
                key={accent}
                type="button"
                data-accent={accent}
                aria-pressed={value.accent === accent}
                aria-label={accentNames[accent]}
                onClick={() => change('accent', accent)}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="karavan-module__choices">
          <legend>Главная магазина</legend>
          {value.blocks.map((block, index) => (
            <div className="karavan-shop__block" key={block.id}>
              <label>
                <input
                  type="checkbox"
                  checked={block.visible}
                  onChange={(event) =>
                    change(
                      'blocks',
                      value.blocks.map((row) =>
                        row.id === block.id ? { ...row, visible: event.target.checked } : row,
                      ),
                    )
                  }
                />
                {blockNames[block.id]}
              </label>
              <button
                type="button"
                aria-label={`Выше: ${blockNames[block.id]}`}
                disabled={index === 0}
                onClick={() => {
                  const next = [...value.blocks];
                  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                  change('blocks', next);
                }}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Ниже: ${blockNames[block.id]}`}
                disabled={index === value.blocks.length - 1}
                onClick={() => {
                  const next = [...value.blocks];
                  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                  change('blocks', next);
                }}
              >
                ↓
              </button>
            </div>
          ))}
        </fieldset>
      </fieldset>
      {uploading ? <p role="status">Загружаем изображение…</p> : null}
      <p className="karavan-shop__draft-status" role="status">
        {dirty
          ? 'Есть несохранённые изменения'
          : query.data.hasChanges
            ? 'Черновик сохранён. Примените оформление, чтобы его увидели покупатели.'
            : 'Покупатели видят это оформление'}
      </p>
      <StorefrontActions page="appearance">
        {dirty ? (
          <button
            type="button"
            className="karavan-module__primary"
            disabled={uploading || mutation.isPending}
            onClick={() => {
              const parsed = marketplaceAppearanceSchema.safeParse(value);
              if (!parsed.success) {
                setError('Проверьте название и выберите хотя бы один раздел.');
                return;
              }
              void mutation
                .mutateAsync({
                  operation: 'appearance_save',
                  input: {
                    commandId: crypto.randomUUID(),
                    expectedRevision: query.data.revision,
                    appearance: parsed.data,
                  },
                })
                .then(() => setDraft(null))
                .catch(() => {});
            }}
          >
            Сохранить черновик
          </button>
        ) : null}
        {onView ? (
          <button
            type="button"
            disabled={dirty || uploading || mutation.isPending}
            onClick={onView}
          >
            Посмотреть магазин чата
          </button>
        ) : null}
        {!dirty && query.data.hasChanges ? (
          <button
            type="button"
            className="karavan-module__primary"
            disabled={uploading || mutation.isPending}
            onClick={() =>
              mutation.mutate({
                operation: 'appearance_publish',
                input: { commandId: crypto.randomUUID(), expectedRevision: query.data.revision },
              })
            }
          >
            Применить оформление
          </button>
        ) : null}
      </StorefrontActions>
    </>
  );
}
