import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { ManagedModeratorAssignmentResult } from '@maxim/contracts';
import publikPortrait from '../assets/bots/publik.webp';
import { isTopmostModalDialog, useDialogFocusTrap } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import { openPublikBot, PUBLIK_BOT_URL } from '../lib/publik-bot';
import { queryKeys } from '../lib/query-keys';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import HomeModeratorChoice from '../pages/home-moderator-choice';
import { AppIcon } from './ui/app-icon';
import { useToast } from './ui/toast';
import type { ManagedEntityBotsControlProps } from './managed-entity-bots-control';
import '../pages/home-moderator.css';
import './managed-entity-bots-sheet.css';

export type ManagedEntityBotsSheetProps = ManagedEntityBotsControlProps & {
  id: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

export default function ManagedEntityBotsSheet({
  api,
  userId,
  entityType,
  entityId,
  title,
  id,
  onClose,
  returnFocusRef,
}: ManagedEntityBotsSheetProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const overlayStyle = useVisualViewportOverlayStyle(true);
  // FLAG: Callers resolve identity before mounting so pending operations keep one user scope.
  const scope = `u:${userId}`;
  const heading = entityType === 'channel' ? 'Боты канала' : 'Боты чата';
  const subtitle = title.trim() || (entityType === 'channel' ? 'Канал' : 'Чат');

  useLayoutEffect(() => {
    const background = new Map<HTMLElement, boolean>();
    let branch: HTMLElement | null = overlayRef.current;
    while (branch?.parentElement) {
      const parent: HTMLElement = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      if (parent === document.body) break;
      branch = parent;
    }
    return () => {
      for (const [element, wasInert] of background) element.inert = wasInert;
    };
  }, []);

  useDialogFocusTrap(true, panelRef, panelRef, returnFocusRef);
  useNativeBackHandler(
    () => {
      if (!panelRef.current || !isTopmostModalDialog(panelRef.current)) return false;
      onClose();
      return true;
    },
    { priority: 660 },
  );

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !panelRef.current || !isTopmostModalDialog(panelRef.current))
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  function handleSaved(result: ManagedModeratorAssignmentResult) {
    // FLAG: Only the picker's confirmed, durably cleared operation reaches this callback.
    // Mark settings stale without refetching over a live autosave draft.
    void Promise.allSettled([
      queryClient.invalidateQueries({
        queryKey: ['me-sync', entityType, `home:${scope}`],
        exact: true,
        refetchType: 'none',
      }),
      queryClient.invalidateQueries({
        queryKey:
          entityType === 'channel'
            ? queryKeys.channelSettingsScreen(entityId)
            : queryKeys.chatSettingsScreen(entityId),
        refetchType: 'none',
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.currentUser(entityId),
        exact: true,
        refetchType: 'none',
      }),
      queryClient.invalidateQueries({
        queryKey: ['settings-header-bot-load'],
        refetchType: 'none',
      }),
    ]);
    pushToast({
      title: 'Бот выбран',
      description: result.moderator.name,
      tone: 'success',
      replaceKey: `moderator:${scope}:${entityType}:${entityId}`,
    });
    onClose();
  }

  if (typeof document === 'undefined') return null;
  const portalTarget =
    window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ === true
      ? document.body
      : (document.querySelector('.design-preview__device-screen') ?? document.body);

  return createPortal(
    <div ref={overlayRef} className="managed-entity-bots-sheet" style={overlayStyle}>
      <button
        type="button"
        className="managed-entity-bots-sheet__backdrop"
        aria-label="Закрыть ботов"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={panelRef}
        id={id}
        className="managed-entity-bots-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-subtitle`}
        tabIndex={-1}
      >
        <header className="managed-entity-bots-sheet__header">
          <div className="managed-entity-bots-sheet__identity">
            <h2 id={`${id}-title`}>{heading}</h2>
            <p id={`${id}-subtitle`}>{subtitle}</p>
          </div>
          <button
            type="button"
            className="managed-entity-bots-sheet__close"
            aria-label="Закрыть ботов"
            onClick={onClose}
          >
            <AppIcon icon="Xmark" />
          </button>
        </header>
        <section
          className="managed-entity-bots-sheet__publications"
          aria-labelledby={`${id}-publications`}
        >
          <h3 id={`${id}-publications`}>Публикации</h3>
          <a
            className="managed-entity-bots-sheet__publik"
            href={PUBLIK_BOT_URL}
            onClick={openPublikBot}
            title="Открыть бота Публик"
          >
            <img src={publikPortrait} width={40} height={40} alt="" />
            <span>
              <strong>Публик</strong>
              <small>Публикации и расписания</small>
            </span>
            <AppIcon icon="SendDiagonal" />
          </a>
        </section>
        <section
          className="managed-entity-bots-sheet__moderation"
          aria-labelledby={`${id}-moderation`}
        >
          <h3 id={`${id}-moderation`}>
            <AppIcon icon="ShieldCheck" />
            Модерация
          </h3>
          <div className="managed-entity-bots-sheet__choices">
            <HomeModeratorChoice
              api={api}
              scope={scope}
              entityType={entityType}
              entityId={entityId}
              onSaved={handleSaved}
            />
          </div>
        </section>
      </section>
    </div>,
    portalTarget,
  );
}
