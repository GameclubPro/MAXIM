import { useRef, type CSSProperties, type ReactNode, type SVGProps } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { StatsUpSquare } from 'iconoir-react';
import type { ChatSummary, ManagedEntityFavoriteType } from '@maxim/contracts';
import {
  HOME_ENTITY_FAVORITE_ICONS,
  XmarkGlyph,
} from '../components/ui/compact-icons';
import { cn } from '../lib/cn';
import { useDialogFocusTrap } from '../lib/dialog-focus';
import {
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TYPES,
  type HomeEntityFavoriteLabelOverrides,
} from '../lib/home-entity-favorites';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';

type ManagedTab = 'chat' | 'channel';
type SheetTarget = {
  entityType: ManagedTab;
  entity: ChatSummary;
};
type FavoriteLabelDraft = Record<ManagedEntityFavoriteType, string>;

type HomeEntitySheetsProps = {
  actionTarget: SheetTarget | null;
  favoriteTarget: SheetTarget | null;
  labelsEditorOpen: boolean;
  favoriteLabels: FavoriteLabelDraft;
  favoriteLabelOverrides: HomeEntityFavoriteLabelOverrides;
  favoriteLabelDraft: FavoriteLabelDraft;
  selectedFavoriteTypes: ManagedEntityFavoriteType[];
  favoriteSaving: boolean;
  canSaveLabels: boolean;
  onClose: () => void;
  onOpenFavorite: () => void;
  onActivityIntent: () => void;
  onActivityOpen: () => void;
  onToggleFavorite: (favoriteType: ManagedEntityFavoriteType) => void;
  onFavoriteLabelChange: (favoriteType: ManagedEntityFavoriteType, value: string) => void;
  onFavoriteLabelReset: (favoriteType: ManagedEntityFavoriteType) => void;
  onFavoriteLabelsSave: () => void;
};

function PlusGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

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

function buildActivityRoute(target: SheetTarget): string {
  return target.entityType === 'channel'
    ? `/channel/${target.entity.id}/stats?section=overview`
    : `/chat/${target.entity.id}/events?section=activity`;
}

function buildRouteState(target: SheetTarget) {
  return {
    chatTitle: target.entity.title,
    avatarUrl: target.entity.avatarUrl ?? null,
    ...(target.entityType === 'channel' ? { chatLink: target.entity.link ?? '' } : {}),
  };
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

export default function HomeEntitySheets(props: HomeEntitySheetsProps) {
  const overlayStyle = useVisualViewportOverlayStyle(true);

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

  if (!props.actionTarget) {
    return null;
  }

  const favorite = props.selectedFavoriteTypes.length > 0;
  const PrimaryFavoriteIcon = favorite
    ? HOME_ENTITY_FAVORITE_ICONS[props.selectedFavoriteTypes[0]]
    : PlusGlyph;
  return (
    <HomeSheet
      key="actions"
      sheetKey="actions"
      title={props.actionTarget.entity.title}
      panelClassName="home-actions__panel"
      overlayStyle={overlayStyle}
      onClose={props.onClose}
    >
      <div className="favorite-picker__grid home-actions__grid">
        <Link
          to={buildActivityRoute(props.actionTarget)}
          state={buildRouteState(props.actionTarget)}
          className="favorite-picker__option home-actions__item"
          onClick={props.onActivityOpen}
          onPointerEnter={props.onActivityIntent}
          onPointerDown={props.onActivityIntent}
        >
          <span className="favorite-picker__icon">
            <StatsUpSquare aria-hidden focusable="false" />
          </span>
          <strong>Статистика</strong>
        </Link>
        <button
          type="button"
          className={cn(
            'favorite-picker__option home-actions__item',
            favorite && 'is-active',
            props.selectedFavoriteTypes[0] && `is-${props.selectedFavoriteTypes[0]}`,
          )}
          aria-haspopup="dialog"
          disabled={props.favoriteSaving}
          onClick={props.onOpenFavorite}
        >
          <span className="favorite-picker__icon">
            <PrimaryFavoriteIcon aria-hidden />
          </span>
          <strong>{favorite ? 'Категория' : 'В избранное'}</strong>
          {favorite ? (
            <small>
              {props.selectedFavoriteTypes
                .map((favoriteType) => props.favoriteLabels[favoriteType])
                .join(', ')}
            </small>
          ) : null}
        </button>
      </div>
    </HomeSheet>
  );
}
