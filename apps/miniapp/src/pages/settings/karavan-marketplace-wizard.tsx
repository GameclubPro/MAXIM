import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  karavanMarketplaceSetupSchema,
  karavanMarketplaceCategories,
  type KaravanMarketplaceSetup,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getAvailableKaravanMarketplaces,
  getKaravanMarketplaceSetupOptions,
  previewKaravanMarketplace,
} from '../../lib/api/karavan-marketplace-client';
import {
  hydrateMirroredItem,
  saveMirroredItem,
  removeMirroredItem,
} from '../../lib/native-storage';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { useStorefrontBack, useStorefrontWorkspace } from './storefront-workspace';

const defaultRules =
  'Продавец отвечает за описание, актуальность предложений и выполнение договорённостей. Размещение витрин — после проверки администратора. Запрещены товары и услуги, нарушающие закон и правила MAX.';
const draftSchema = z
  .object({
    mode: z.enum(['new', 'existing']),
    existingId: z.string().uuid().nullable(),
    name: z.string().max(120),
    rules: z.string().max(12000),
    categories: z.array(z.string().max(100)).max(40),
    subcategories: z.array(z.string().max(100)).max(1000),
    initialized: z.boolean(),
    admissionPolicy: z.enum(['applications', 'invitation']),
    chatIds: z
      .array(z.string().regex(/^-?\d{1,24}$/u))
      .min(1)
      .max(20),
  })
  .strict();
type Draft = z.infer<typeof draftSchema>;

export default function KaravanMarketplaceWizard({
  api,
  chatId,
  chatTitle,
  actorId,
  existing = false,
  initialMarketplaceId,
  onSubmit,
  onCancel,
}: {
  api: ApiTransport;
  chatId: string;
  chatTitle: string;
  actorId: string;
  existing?: boolean;
  initialMarketplaceId?: string;
  onSubmit: (input: KaravanMarketplaceSetup) => void;
  onCancel: () => void;
}) {
  const storageKey = `karavan-setup-draft:v1:${actorId}:${chatId}${initialMarketplaceId ? `:${initialMarketplaceId}` : ''}`;
  const [draft, setDraft] = useState<Draft>({
    mode: existing ? 'existing' : 'new',
    existingId: initialMarketplaceId ?? null,
    name: chatTitle.slice(0, 120),
    rules: defaultRules,
    categories: [],
    subcategories: [],
    initialized: false,
    admissionPolicy: 'applications',
    chatIds: [chatId],
  });
  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [showChats, setShowChats] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [visibleChats, setVisibleChats] = useState(20);
  const [notice, setNotice] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const options = useQuery({
    queryKey: ['karavan-setup-options', actorId, chatId],
    queryFn: ({ signal }) => getKaravanMarketplaceSetupOptions(api, chatId, signal),
    retry: false,
  });
  const available = useInfiniteQuery({
    queryKey: ['karavan-available', actorId, chatId],
    enabled: draft.mode === 'existing',
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getAvailableKaravanMarketplaces(api, chatId, pageParam),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const chats = useQuery({
    queryKey: ['karavan-setup-chats', actorId],
    enabled: showChats,
    queryFn: async () => (await import('../../lib/api/root-client')).getChats(api),
    staleTime: 30_000,
    retry: false,
  });
  const preview = useMutation({
    mutationFn: () =>
      previewKaravanMarketplace(api, chatId, {
        chatIds: draft.chatIds,
        marketplaceId: draft.mode === 'existing' ? draft.existingId : null,
      }),
  });
  useEffect(() => {
    let active = true;
    void hydrateMirroredItem(storageKey)
      .then((raw) => {
        if (!active || !raw) return;
        try {
          const parsed = draftSchema.safeParse(JSON.parse(raw));
          if (
            parsed.success &&
            parsed.data.chatIds[0] === chatId &&
            new Set(parsed.data.chatIds).size === parsed.data.chatIds.length
          )
            setDraft(parsed.data);
        } catch {
          /* Invalid local drafts never become commands. */
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, [storageKey, chatId]);
  useEffect(() => {
    if (!hydrated || draft.initialized || !options.data) return;
    setDraft((value) => ({
      ...value,
      name: value.name || options.data.chatTitle.slice(0, 120),
      categories: options.data.categories.map((item) => item.id),
      subcategories: options.data.categories.flatMap((item) =>
        item.subcategories.map((sub) => sub.id),
      ),
      initialized: true,
    }));
  }, [hydrated, draft.initialized, options.data]);
  useEffect(() => {
    if (hydrated) saveMirroredItem(storageKey, JSON.stringify(draft));
  }, [draft, hydrated, storageKey]);
  const change = (patch: Partial<Draft>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setNotice(null);
    setAccepted(false);
    preview.reset();
  };
  const back = () => {
    if (preview.isPending) return false;
    if (step === 1) onCancel();
    else setStep(step === 3 ? 2 : 1);
    setAccepted(false);
    return true;
  };
  const workspace = useStorefrontWorkspace();
  useStorefrontBack(back, workspace?.page !== 'publications');
  async function next() {
    setNotice(null);
    if (step === 1) {
      if (draft.mode === 'existing') {
        try {
          await preview.mutateAsync();
        } catch (error) {
          setNotice(describeUserFacingError(error, 'Не удалось проверить выбранный магазин.'));
          return;
        }
      }
      setStep(2);
      return;
    }
    if (
      draft.mode === 'new' &&
      (!draft.name.trim() ||
        !draft.rules.trim() ||
        draft.categories.length === 0 ||
        !options.data ||
        draft.categories.some(
          (id) =>
            !options.data.categories.some(
              (category) =>
                category.id === id &&
                (id === 'real_estate' ||
                  category.subcategories.some((sub) => draft.subcategories.includes(sub.id))),
            ),
        ))
    ) {
      setNotice(
        'Укажите название и правила. Выберите хотя бы одно направление в каждой категории.',
      );
      return;
    }
    try {
      const reviewedRevision = preview.data?.target?.marketplace.policyRevision;
      const latest = await preview.mutateAsync();
      setAccepted(false);
      if (
        draft.mode === 'existing' &&
        reviewedRevision !== latest.target?.marketplace.policyRevision
      ) {
        setNotice('Правила изменились. Проверьте их ещё раз.');
        return;
      }
      setStep(3);
    } catch (error) {
      setNotice(
        describeUserFacingError(error, 'Не удалось проверить подключения. Повторите попытку.'),
      );
    }
  }
  function submit() {
    if (!preview.data || !accepted) return;
    const parsed = karavanMarketplaceSetupSchema.safeParse({
      operationId: crypto.randomUUID(),
      chatIds: draft.chatIds,
      ...(draft.mode === 'new'
        ? {
            create: {
              name: draft.name,
              admissionPolicy: draft.admissionPolicy,
              rules: {
                text: draft.rules,
                allowedCategoryIds: draft.categories,
                allowedSubcategoryIds: draft.subcategories.filter((id) =>
                  options.data?.categories.some(
                    (category) =>
                      draft.categories.includes(category.id) &&
                      category.subcategories.some((sub) => sub.id === id),
                  ),
                ),
                categoryOrder: draft.categories,
              },
            },
          }
        : {
            existingMarketplaceId: draft.existingId,
            expectedPolicyRevision: preview.data.target?.marketplace.policyRevision,
          }),
      bindingExpectations: preview.data.chats.map((chat) => ({
        chatId: chat.chatId,
        generation: chat.binding?.generation ?? null,
        action: !chat.binding
          ? 'bind_chat'
          : chat.marketplace?.id === draft.existingId && draft.mode === 'existing'
            ? chat.binding.state === 'verified'
              ? 'bind_chat'
              : 'recover_chat'
            : 'transfer_chat',
      })),
    });
    if (!parsed.success) {
      setNotice('Проверьте настройки и повторите проверку подключений.');
      return;
    }
    // The parent persists the immutable submitted command before any request.
    onSubmit(parsed.data);
    removeMirroredItem(storageKey);
  }
  const target = preview.data?.target;
  const eligible =
    available.data?.pages
      .flatMap((page) => page.marketplaces)
      .filter(
        (item) =>
          item.marketplace.status !== 'archived' &&
          (item.permissions.includes('bind_chat') ||
            item.permissions.includes('manage_network') ||
            item.permissions.includes('manage_marketplace')),
      ) ?? [];
  const matchingChats =
    chats.data?.filter(
      (chat) =>
        chat.id !== chatId &&
        chat.title.toLocaleLowerCase('ru').includes(chatSearch.toLocaleLowerCase('ru')),
    ) ?? [];
  return (
    <div className="karavan-module__wizard">
      <p role="status">Шаг {step} из 3</p>
      <h3>
        {step === 1
          ? 'Магазин и чаты'
          : step === 2
            ? draft.mode === 'new'
              ? 'Название и правила'
              : 'Правила выбранного магазина'
            : 'Проверка подключения'}
      </h3>
      {notice ? (
        <p role="alert" className="karavan-module__notice">
          {notice}
        </p>
      ) : null}
      <fieldset className="karavan-module__wizard-fields" disabled={!hydrated || preview.isPending}>
        {step === 1 ? (
          <>
            <fieldset className="karavan-module__choices">
              <legend>Магазин</legend>
              <label>
                <input
                  type="radio"
                  name="karavan-setup-mode"
                  checked={draft.mode === 'new'}
                  onChange={() => change({ mode: 'new' })}
                />
                Создать магазин
              </label>
              <label>
                <input
                  type="radio"
                  name="karavan-setup-mode"
                  checked={draft.mode === 'existing'}
                  onChange={() => change({ mode: 'existing' })}
                />
                Выбрать существующий
              </label>
            </fieldset>
            {draft.mode === 'existing' ? (
              <fieldset className="karavan-module__choices">
                <legend>Доступные магазины</legend>
                {available.isPending ? (
                  <p>Загружаем магазины…</p>
                ) : available.isError ? (
                  <>
                    <p role="alert">Не удалось загрузить магазины.</p>
                    <button type="button" onClick={() => void available.refetch()}>
                      Повторить
                    </button>
                  </>
                ) : eligible.length === 0 ? (
                  <p>Нет магазинов, которые вы можете подключить.</p>
                ) : (
                  eligible.map((item) => (
                    <label key={item.marketplace.id}>
                      <input
                        type="radio"
                        name="karavan-existing"
                        checked={draft.existingId === item.marketplace.id}
                        onChange={() => change({ existingId: item.marketplace.id })}
                      />
                      {item.marketplace.name}
                    </label>
                  ))
                )}
                {available.hasNextPage ? (
                  <button
                    type="button"
                    disabled={available.isFetchingNextPage}
                    onClick={() => void available.fetchNextPage()}
                  >
                    Показать ещё магазины
                  </button>
                ) : null}
              </fieldset>
            ) : null}
            <p className="karavan-module__selected-chat">
              {chatTitle || options.data?.chatTitle || 'Текущий чат'}
            </p>
            <button
              type="button"
              aria-expanded={showChats}
              onClick={() => setShowChats(!showChats)}
            >
              Добавить мои чаты · {draft.chatIds.length}
            </button>
            {showChats ? (
              <fieldset className="karavan-module__choices">
                <legend>Чаты общего магазина</legend>
                <p>Общие продавцы, правила и порядок витрин.</p>
                <label className="karavan-module__field">
                  <span>Найти чат</span>
                  <input
                    value={chatSearch}
                    onChange={(event) => {
                      setChatSearch(event.target.value);
                      setVisibleChats(20);
                    }}
                  />
                </label>
                {chats.isPending ? (
                  <p>Загружаем чаты…</p>
                ) : chats.isError ? (
                  <>
                    <p role="alert">Не удалось загрузить чаты.</p>
                    <button type="button" onClick={() => void chats.refetch()}>
                      Повторить
                    </button>
                  </>
                ) : (
                  matchingChats.slice(0, visibleChats).map((chat) => (
                    <label key={chat.id}>
                      <input
                        type="checkbox"
                        checked={draft.chatIds.includes(chat.id)}
                        disabled={draft.chatIds.length >= 20 && !draft.chatIds.includes(chat.id)}
                        onChange={(event) =>
                          change({
                            chatIds: event.target.checked
                              ? [...draft.chatIds, chat.id]
                              : draft.chatIds.filter((id) => id !== chat.id),
                          })
                        }
                      />
                      {chat.title}
                    </label>
                  ))
                )}
                {!chats.isPending && !chats.isError && matchingChats.length === 0 ? (
                  <p>Других подходящих чатов нет.</p>
                ) : null}
                {matchingChats.length > visibleChats ? (
                  <button type="button" onClick={() => setVisibleChats((value) => value + 20)}>
                    Показать ещё чаты
                  </button>
                ) : null}
                {draft.chatIds.length === 20 ? (
                  <p>За одно подключение можно выбрать до 20 чатов.</p>
                ) : null}
              </fieldset>
            ) : null}
          </>
        ) : step === 2 && draft.mode === 'new' ? (
          <>
            <label className="karavan-module__field">
              <span>Название магазина</span>
              <input
                value={draft.name}
                maxLength={120}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            {options.isPending ? (
              <p>Загружаем категории…</p>
            ) : options.isError ? (
              <>
                <p role="alert">Не удалось загрузить категории.</p>
                <button type="button" onClick={() => void options.refetch()}>
                  Повторить
                </button>
              </>
            ) : (
              <fieldset className="karavan-module__choices">
                <legend>Разрешённые категории</legend>
                {options.data?.categories.map((category) => (
                  <div key={category.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.categories.includes(category.id)}
                        onChange={(event) =>
                          change({
                            categories: event.target.checked
                              ? [...draft.categories, category.id]
                              : draft.categories.filter((id) => id !== category.id),
                            subcategories: event.target.checked
                              ? [
                                  ...new Set([
                                    ...draft.subcategories,
                                    ...category.subcategories.map((sub) => sub.id),
                                  ]),
                                ]
                              : draft.subcategories.filter(
                                  (id) => !category.subcategories.some((sub) => sub.id === id),
                                ),
                          })
                        }
                      />
                      {category.label}
                    </label>
                    {draft.categories.includes(category.id) && category.subcategories.length ? (
                      <details className="karavan-module__subcategories">
                        <summary>
                          Направления ·{' '}
                          {
                            category.subcategories.filter((sub) =>
                              draft.subcategories.includes(sub.id),
                            ).length
                          }{' '}
                          из {category.subcategories.length}
                        </summary>
                        {category.subcategories.map((sub) => (
                          <label key={sub.id}>
                            <input
                              type="checkbox"
                              checked={draft.subcategories.includes(sub.id)}
                              onChange={(event) =>
                                change({
                                  subcategories: event.target.checked
                                    ? [...draft.subcategories, sub.id]
                                    : draft.subcategories.filter((id) => id !== sub.id),
                                })
                              }
                            />
                            {sub.label}
                          </label>
                        ))}
                      </details>
                    ) : null}
                  </div>
                ))}
              </fieldset>
            )}
            <label className="karavan-module__field">
              <span>Правила для продавцов</span>
              <textarea
                rows={5}
                maxLength={12000}
                value={draft.rules}
                onChange={(event) => change({ rules: event.target.value })}
              />
            </label>
            <fieldset className="karavan-module__choices">
              <legend>Приём продавцов</legend>
              <label>
                <input
                  type="radio"
                  name="karavan-admission"
                  checked={draft.admissionPolicy === 'applications'}
                  onChange={() => change({ admissionPolicy: 'applications' })}
                />
                Заявки после проверки
              </label>
              <label>
                <input
                  type="radio"
                  name="karavan-admission"
                  checked={draft.admissionPolicy === 'invitation'}
                  onChange={() => change({ admissionPolicy: 'invitation' })}
                />
                Только по приглашению
              </label>
            </fieldset>
          </>
        ) : step === 2 ? (
          target ? (
            <>
              <strong>{target.marketplace.name}</strong>
              <p>
                Витрины: {target.counts.listings} · Чаты: {target.counts.chats}
              </p>
              <p>Подключаемые чаты получат существующий состав и порядок витрин.</p>
              <p>
                {target.marketplace.admissionPolicy === 'invitation'
                  ? 'Продавцы принимаются по приглашению.'
                  : 'Заявки продавцов рассматривает администратор.'}
              </p>
              <p>
                {target.rules.allowedCategoryIds
                  .map(
                    (id) =>
                      options.data?.categories.find((category) => category.id === id)?.label ??
                      karavanMarketplaceCategories.find(([categoryId]) => categoryId === id)?.[1],
                  )
                  .join(', ')}
              </p>
              {options.isError ? (
                <button type="button" onClick={() => void options.refetch()}>
                  Повторить загрузку категорий
                </button>
              ) : null}
              <p className="karavan-module__rules">{target.rules.text}</p>
            </>
          ) : (
            <p role="alert">Вернитесь к выбору магазина и повторите проверку.</p>
          )
        ) : (
          <>
            <strong>{target?.marketplace.name ?? draft.name}</strong>
            <p>
              {draft.mode === 'new'
                ? 'Создадим черновик. Открытие покупателям — отдельное действие.'
                : 'Подключим чаты к выбранному магазину. Его доступность для покупателей не изменится.'}
            </p>
            <ul className="karavan-module__progress">
              {preview.data?.chats.map((chat) => (
                <li key={chat.chatId}>
                  <span>
                    {chat.title || 'Выбранный чат'}
                    {chat.binding && chat.marketplace?.id !== draft.existingId ? (
                      <small>
                        Прежний магазин отключится. Его продавцы и заказы не переносятся.
                      </small>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <fieldset className="karavan-module__choices">
              <legend>Подтверждение</legend>
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                Подтверждаю выбранные чаты и правила магазина
              </label>
            </fieldset>
          </>
        )}
        <div className="karavan-module__actions">
          <button
            type="button"
            className="karavan-module__primary"
            disabled={
              (step === 1 && draft.mode === 'existing' && !draft.existingId) ||
              (step === 2 && draft.mode === 'new' && !options.data) ||
              (step === 3 && !accepted)
            }
            onClick={() => (step === 3 ? submit() : void next())}
          >
            {preview.isPending
              ? 'Проверяем…'
              : step === 3
                ? draft.mode === 'new'
                  ? 'Создать черновик'
                  : 'Подключить'
                : 'Продолжить'}
          </button>
          <button type="button" onClick={back}>
            {step === 1 ? 'Отмена' : 'Назад'}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
