import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from 'react';
import { createPortal } from 'react-dom';
import type { ChatSummary, ManagedEntityFavoriteType } from '@maxim/contracts';
import {
  FilterGlyph,
  HOME_ENTITY_FAVORITE_ICONS,
  SendGlyph,
  SettingsGlyph,
  XmarkGlyph,
} from '../components/ui/compact-icons';
import { useToast } from '../components/ui/toast';
import { getCachedBotDialogUrl, getMe } from '../lib/api/me-client';
import type { ApiTransport } from '../lib/api/transport';
import { createBotDialogHandoffCoordinator } from '../lib/bot-dialog-handoff';
import { cn } from '../lib/cn';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import {
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TYPES,
  type HomeEntityFavoriteLabelOverrides,
} from '../lib/home-entity-favorites';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';

type ManagedTab = 'chat' | 'channel';
type SheetTarget = {
  entityType: ManagedTab;
  entity: ChatSummary;
};
type FavoriteLabelDraft = Record<ManagedEntityFavoriteType, string>;
type FavoriteFilter = ManagedEntityFavoriteType | 'all';

type HomeEntitySheetsProps = {
  api: ApiTransport;
  connectOpen: boolean;
  favoriteTarget: SheetTarget | null;
  filterPickerOpen: boolean;
  filterValue: FavoriteFilter;
  labelsEditorOpen: boolean;
  favoriteLabels: FavoriteLabelDraft;
  favoriteCounts: Record<ManagedEntityFavoriteType, number>;
  favoriteLabelOverrides: HomeEntityFavoriteLabelOverrides;
  favoriteLabelDraft: FavoriteLabelDraft;
  selectedFavoriteTypes: ManagedEntityFavoriteType[];
  favoriteSaving: boolean;
  canSaveLabels: boolean;
  onClose: () => void;
  onFilterChange: (filter: FavoriteFilter) => void;
  onOpenLabelsEditor: () => void;
  onToggleFavorite: (favoriteType: ManagedEntityFavoriteType) => void;
  onFavoriteLabelChange: (favoriteType: ManagedEntityFavoriteType, value: string) => void;
  onFavoriteLabelReset: (favoriteType: ManagedEntityFavoriteType) => void;
  onFavoriteLabelsSave: () => void;
};

function CheckGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M5 12.4l4.2 4.1L19 7"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HomeSheet({
  sheetKey,
  title,
  subtitle,
  panelClassName,
  overlayStyle,
  onClose,
  children,
}: {
  sheetKey: string;
  title: string;
  subtitle?: string;
  panelClassName?: string;
  overlayStyle: CSSProperties | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap(true, panelRef, closeRef);
  const titleId = `home-sheet-${sheetKey}-title`;
  const sheet = (
    <div className={cn('favorite-picker', `home-sheet--${sheetKey}`)} style={overlayStyle}>
      <button
        type="button"
        className="favorite-picker__backdrop"
        aria-label="Закрыть"
        onClick={onClose}
        tabIndex={-1}
      />
      <section
        ref={panelRef}
        id={`home-sheet-${sheetKey}`}
        className={cn('favorite-picker__panel', panelClassName)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="favorite-picker__header">
          <div>
            <strong id={titleId}>{title}</strong>
            {subtitle ? <span>{subtitle}</span> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="favorite-picker__close"
            aria-label="Закрыть"
            title="Закрыть"
            onClick={onClose}
          >
            <XmarkGlyph aria-hidden />
          </button>
        </div>
        {children}
      </section>
    </div>
  );

  if (typeof document === 'undefined') {
    return sheet;
  }
  return createPortal(
    sheet,
    document.querySelector('.design-preview__device-screen') ?? document.body,
  );
}

function HomeConnectSheet({
  api,
  overlayStyle,
  onClose,
}: {
  api: ApiTransport;
  overlayStyle: CSSProperties | undefined;
  onClose: () => void;
}) {
  const { pushToast } = useToast();
  const [coordinator] = useState(createBotDialogHandoffCoordinator);
  const [pending, setPending] = useState(false);
  const botDialogUrlRef = useRef(getCachedBotDialogUrl(api));

  useEffect(() => {
    const cachedUrl = getCachedBotDialogUrl(api);
    if (cachedUrl) {
      botDialogUrlRef.current = cachedUrl;
      return undefined;
    }

    const controller = new AbortController();

    void getMe(api, { signal: controller.signal })
      .then((me) => {
        if (!controller.signal.aborted) {
          botDialogUrlRef.current = me.botDialogUrl;
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [api]);

  useEffect(
    () => () => {
      coordinator.cancel();
    },
    [coordinator],
  );

  function closeSheet() {
    coordinator.cancel();
    setPending(false);
    onClose();
  }

  async function returnToBot() {
    setPending(true);
    const outcome = await coordinator.run(async (signal) => {
      const cachedUrl = botDialogUrlRef.current ?? getCachedBotDialogUrl(api);
      if (cachedUrl) {
        botDialogUrlRef.current = cachedUrl;
        return cachedUrl;
      }
      const me = await getMe(api, { signal });
      if (signal.aborted) {
        return null;
      }
      botDialogUrlRef.current = me.botDialogUrl;
      return me.botDialogUrl;
    }, openMaxBotLinkAndClose);

    if (outcome === 'busy' || outcome === 'opened') {
      return;
    }

    setPending(false);
    if (outcome === 'failed') {
      pushToast({
        title: 'Не удалось открыть диалог',
        description: 'Попробуйте ещё раз.',
        tone: 'danger',
      });
    }
  }

  return (
    <HomeSheet
      sheetKey="connect"
      title="Подключить чат или канал"
      panelClassName="home-connect__panel"
      overlayStyle={overlayStyle}
      onClose={closeSheet}
    >
      <ol className="home-connect__steps" role="list">
        <li>
          <span aria-label="Шаг 1">1</span>
          <div>
            <strong>Добавьте бота в администраторы</strong>
            <small>Включите доступ ко всем сообщениям.</small>
          </div>
        </li>
        <li>
          <span aria-label="Шаг 2">2</span>
          <div>
            <strong>Перешлите боту любое сообщение или пост</strong>
            <small>Из нужного чата или канала в личный диалог с ботом.</small>
          </div>
        </li>
      </ol>
      <div className="home-connect__handoff">
        <p>Бот проверит права и добавит чат или канал.</p>
        <button
          type="button"
          className="button button--accent"
          onClick={() => void returnToBot()}
          disabled={pending}
        >
          <SendGlyph aria-hidden focusable="false" />
          {pending ? 'Открываем...' : 'Открыть диалог с ботом'}
        </button>
      </div>
    </HomeSheet>
  );
}

export default function HomeEntitySheets(props: HomeEntitySheetsProps) {
  const overlayStyle = useVisualViewportOverlayStyle(true);

  if (props.connectOpen) {
    return (
      <HomeConnectSheet
        key="connect"
        api={props.api}
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      />
    );
  }

  if (props.labelsEditorOpen) {
    return (
      <HomeSheet
        key="labels"
        sheetKey="labels"
        title="Категории избранного"
        panelClassName="favorite-label-editor__panel"
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      >
        <div className="favorite-label-editor__list">
          {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
            const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
            const isCustom = Boolean(props.favoriteLabelOverrides[favoriteType]);
            return (
              <label key={favoriteType} className="favorite-label-editor__row">
                <span className={cn('favorite-label-editor__icon', `is-${favoriteType}`)}>
                  <FavoriteIcon aria-hidden />
                </span>
                <input
                  type="text"
                  inputMode="text"
                  value={props.favoriteLabelDraft[favoriteType]}
                  maxLength={HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH}
                  aria-label={`Название категории: ${HOME_ENTITY_FAVORITE_LABELS[favoriteType]}`}
                  onChange={(event) =>
                    props.onFavoriteLabelChange(favoriteType, event.currentTarget.value)
                  }
                />
                <button
                  type="button"
                  className="favorite-label-editor__reset"
                  aria-label="Вернуть стандартное название"
                  title="Вернуть стандартное название"
                  disabled={
                    !isCustom &&
                    props.favoriteLabelDraft[favoriteType] ===
                      HOME_ENTITY_FAVORITE_LABELS[favoriteType]
                  }
                  onClick={() => props.onFavoriteLabelReset(favoriteType)}
                >
                  <XmarkGlyph aria-hidden />
                </button>
              </label>
            );
          })}
        </div>
        <div className="favorite-label-editor__actions">
          <button type="button" className="button button--ghost" onClick={props.onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="button button--accent"
            onClick={props.onFavoriteLabelsSave}
            disabled={!props.canSaveLabels}
          >
            Сохранить
          </button>
        </div>
      </HomeSheet>
    );
  }

  if (props.favoriteTarget) {
    return (
      <HomeSheet
        key="favorite"
        sheetKey="favorite"
        title="Категория"
        subtitle={props.favoriteTarget.entity.title}
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      >
        <div className="favorite-picker__grid">
          {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
            const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
            const active = props.selectedFavoriteTypes.includes(favoriteType);
            return (
              <button
                key={favoriteType}
                type="button"
                className={cn(
                  'favorite-picker__option',
                  `is-${favoriteType}`,
                  active && 'is-active',
                )}
                aria-pressed={active}
                disabled={props.favoriteSaving}
                onClick={() => props.onToggleFavorite(favoriteType)}
              >
                <span className="favorite-picker__icon">
                  <FavoriteIcon aria-hidden />
                </span>
                <strong>{props.favoriteLabels[favoriteType]}</strong>
                {active ? <CheckGlyph aria-hidden className="favorite-picker__check" /> : null}
              </button>
            );
          })}
        </div>
      </HomeSheet>
    );
  }

  if (props.filterPickerOpen) {
    return (
      <HomeSheet
        key="filter"
        sheetKey="filter"
        title="Фильтр категорий"
        panelClassName="home-filter__panel"
        overlayStyle={overlayStyle}
        onClose={props.onClose}
      >
        <div
          className="favorite-picker__grid home-filter__grid"
          role="group"
          aria-label="Категория"
        >
          <button
            type="button"
            className={cn(
              'favorite-picker__option home-filter__item',
              props.filterValue === 'all' && 'is-active',
            )}
            aria-pressed={props.filterValue === 'all'}
            onClick={() => props.onFilterChange('all')}
          >
            <span className="favorite-picker__icon">
              <FilterGlyph aria-hidden focusable="false" />
            </span>
            <strong>Все</strong>
            {props.filterValue === 'all' ? (
              <CheckGlyph aria-hidden className="favorite-picker__check" />
            ) : null}
          </button>
          {HOME_ENTITY_FAVORITE_TYPES.filter(
            (favoriteType) =>
              props.favoriteCounts[favoriteType] > 0 || props.filterValue === favoriteType,
          ).map((favoriteType) => {
            const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
            const count = props.favoriteCounts[favoriteType];
            const active = props.filterValue === favoriteType;
            return (
              <button
                key={favoriteType}
                type="button"
                className={cn(
                  'favorite-picker__option',
                  'home-filter__item',
                  `is-${favoriteType}`,
                  active && 'is-active',
                )}
                aria-pressed={active}
                disabled={count === 0 && !active}
                onClick={() => props.onFilterChange(favoriteType)}
              >
                <span className="favorite-picker__icon">
                  <FavoriteIcon aria-hidden />
                </span>
                <strong>{props.favoriteLabels[favoriteType]}</strong>
                <small>{count}</small>
                {active ? <CheckGlyph aria-hidden className="favorite-picker__check" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            className="favorite-picker__option home-filter__manage"
            onClick={props.onOpenLabelsEditor}
          >
            <span className="favorite-picker__icon">
              <SettingsGlyph aria-hidden focusable="false" />
            </span>
            <strong>Настроить названия</strong>
          </button>
        </div>
      </HomeSheet>
    );
  }

  return null;
}
