import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './marketplace-profile-panel.css';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import { SettingsSectionIcon } from './ui/settings-section-toggle';
import { AppIcon } from './ui/app-icon';
import MarketplaceEntryWorkspace from './marketplace-entry-workspace';
import { MarketplaceActionsContext } from './marketplace-editor-actions';
import type { MarketplaceProfileCardProps } from './marketplace-profile-card';

const ActionConfirmSheet = lazy(() =>
  import('./ui/action-confirm-sheet').then((module) => ({ default: module.ActionConfirmSheet })),
);
type PanelProps = MarketplaceProfileCardProps & { id: string; onClose: () => void };
export type MarketplaceScreen = 'overview' | 'profile' | 'buttons';
export type MarketplaceDrafts = Record<Exclude<MarketplaceScreen, 'overview'>, boolean>;

export default function MarketplaceProfilePanel(props: PanelProps) {
  return (
    <MarketplacePanelContents
      key={`${props.profile}:${props.entityType}:${props.entityId}`}
      {...props}
    />
  );
}

function MarketplacePanelContents({ id, onClose, ...props }: PanelProps) {
  const [drafts, setDrafts] = useState<MarketplaceDrafts>({ profile: false, buttons: false });
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<MarketplaceScreen>('overview');
  const [resetDraftVersion, setResetDraftVersion] = useState(0);
  const [confirmExit, setConfirmExit] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ navigate: () => void } | null>(null);
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const [actionsActive, setActionsActive] = useState(false);
  const actionsContext = useMemo(
    () => ({ host: actionsHost, setActive: setActionsActive }),
    [actionsHost],
  );
  const lastEdited = useRef<'profile' | 'buttons'>('profile');
  const lastFields = useRef<Partial<Record<MarketplaceScreen, string>>>({});
  const positions = useRef<
    Partial<
      Record<
        MarketplaceScreen,
        {
          scrollTop: number;
          focus: HTMLElement | null;
          action: string | null;
          field: string | null;
        }
      >
    >
  >({});
  const dirty = drafts.profile || drafts.buttons;
  const currentPanel = () =>
    document.getElementById(`${id}-title`)?.closest<HTMLElement>('[role="dialog"]');
  const openScreen = (next: MarketplaceScreen, source?: HTMLElement) => {
    if (next === screen) return;
    const focus =
      source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const body = currentPanel()?.querySelector('.settings-drilldown__body');
    positions.current[screen] = {
      scrollTop: body?.scrollTop ?? 0,
      focus,
      action: focus?.dataset.marketplaceAction ?? null,
      field:
        focus?.dataset.marketplaceField ??
        (!focus || !body?.contains(focus) ? (lastFields.current[screen] ?? null) : null),
    };
    setScreen(next);
  };
  const continueEditing = () => {
    const target = drafts[lastEdited.current]
      ? lastEdited.current
      : drafts.profile
        ? 'profile'
        : 'buttons';
    setPendingNavigation(null);
    openScreen(target);
  };
  const discardDrafts = () => {
    setResetDraftVersion((value) => value + 1);
    setDrafts({ profile: false, buttons: false });
  };
  const requestExit = () => {
    if (busy) return;
    if (dirty) setConfirmExit(true);
    else onClose();
  };
  const requestNavigation = (navigate: () => void) => {
    if (busy) return;
    if (dirty) setPendingNavigation({ navigate });
    else {
      openScreen('overview');
      navigate();
    }
  };
  // FLAG: A hidden editor remains part of this session. Only a confirmed full
  // exit or external handoff may discard both drafts; internal Back preserves them.
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  // FLAG: Native Back runs outside React events. Restore only after the target
  // DOM and its footer have committed, without scrolling a restored focus target.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const panel = currentPanel();
      const saved = positions.current[screen];
      const body = panel?.querySelector('.settings-drilldown__body');
      if (body) body.scrollTop = saved?.scrollTop ?? 0;
      // FLAG: Profile fields remount after Back. Restore their stable field key,
      // including when clicking the header Back moved focus out of the editor.
      const field = [
        ...(panel?.querySelectorAll<HTMLElement>('[data-marketplace-field]') ?? []),
      ].find((element) => saved?.field && element.dataset.marketplaceField === saved.field);
      const focus =
        field ??
        (saved?.focus?.isConnected
          ? saved.focus
          : [...(panel?.querySelectorAll<HTMLElement>('[data-marketplace-action]') ?? [])].find(
              (element) => saved?.action && element.dataset.marketplaceAction === saved.action,
            ));
      if (focus?.getClientRects().length) focus.focus({ preventScroll: true });
      else panel?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [screen, id]);
  useEffect(() => {
    const body = currentPanel()?.querySelector<HTMLElement>('.settings-drilldown__body');
    if (!body) return;
    let frame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const input = document.activeElement;
        if (
          !(input instanceof HTMLElement) ||
          !body.contains(input) ||
          !input.matches('input, textarea, select, [contenteditable="true"]')
        )
          return;
        const bounds = body.getBoundingClientRect();
        const field = input.getBoundingClientRect();
        if (field.bottom > bounds.bottom - 8) body.scrollTop += field.bottom - bounds.bottom + 8;
        else if (field.top < bounds.top + 8) body.scrollTop -= bounds.top + 8 - field.top;
      });
    };
    // FLAG: A keyboard and the save footer shrink the actual scroll body.
    // Viewport-only checks miss a field covered by that footer, especially in Publik.
    const observer = new ResizeObserver(revealInput);
    const rememberField = (event: FocusEvent) => {
      const field = event.target;
      if (field instanceof HTMLElement && field.dataset.marketplaceField)
        lastFields.current[screen] = field.dataset.marketplaceField;
      revealInput();
    };
    observer.observe(body);
    body.addEventListener('focusin', rememberField);
    window.visualViewport?.addEventListener('resize', revealInput);
    window.visualViewport?.addEventListener('scroll', revealInput);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      body.removeEventListener('focusin', rememberField);
      window.visualViewport?.removeEventListener('resize', revealInput);
      window.visualViewport?.removeEventListener('scroll', revealInput);
    };
  }, [screen, id]);
  const title = { overview: 'Рекламная биржа', profile: 'Профиль', buttons: 'Кнопка в сообщениях' }[
    screen
  ];
  return (
    <>
      <SettingsDrilldownPanel
        id={id}
        icon={props.profile === 'moderation' ? <SettingsSectionIcon name="ads" /> : undefined}
        open
        title={title}
        tone={props.profile === 'moderation' ? 'sky' : undefined}
        variant="screen"
        overlayClassName="marketplace-profile-overlay"
        onClose={requestExit}
        onBack={screen === 'overview' ? requestExit : () => openScreen('overview')}
        closeDisabled={busy}
        headerAction={
          screen !== 'overview' ? (
            <button
              type="button"
              className="settings-drilldown__close marketplace-workspace-back"
              aria-label="Назад"
              disabled={busy}
              onClick={() => openScreen('overview')}
            >
              <AppIcon icon="ArrowLeft" aria-hidden />
            </button>
          ) : undefined
        }
        footer={
          actionsActive ? (
            <div ref={setActionsHost} className="marketplace-actions-host" />
          ) : undefined
        }
        keepFooterVisibleWhenKeyboardOpen
      >
        <MarketplaceActionsContext.Provider value={actionsContext}>
          <MarketplaceEntryWorkspace
            {...props}
            screen={screen}
            onScreenChange={openScreen}
            onDraftsChange={setDrafts}
            onDraftChange={(editor) => {
              lastEdited.current = editor;
            }}
            onBusyChange={setBusy}
            resetDraftVersion={resetDraftVersion}
            onRequestExternalNavigation={requestNavigation}
          />
          {screen === 'overview' && dirty && (
            <div className="marketplace-workspace-draft" role="status">
              <p>Есть несохранённые изменения</p>
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={continueEditing}
              >
                Продолжить редактирование
              </button>
            </div>
          )}
        </MarketplaceActionsContext.Provider>
      </SettingsDrilldownPanel>
      {(confirmExit || pendingNavigation) && (
        <Suspense fallback={null}>
          <ActionConfirmSheet
            id={`${id}-workspace-confirmation`}
            open
            title={pendingNavigation ? 'Есть несохранённые изменения' : 'Выйти без сохранения?'}
            summary={
              pendingNavigation ? 'Перед переходом в Биржик сохраните их или отмените.' : undefined
            }
            confirmLabel={
              pendingNavigation ? 'Отменить изменения и перейти' : 'Выйти без сохранения'
            }
            cancelLabel="Остаться"
            extraActionLabel={pendingNavigation ? 'Продолжить редактирование' : undefined}
            onExtraAction={pendingNavigation ? continueEditing : undefined}
            isBusy={busy}
            onClose={() => {
              setConfirmExit(false);
              setPendingNavigation(null);
            }}
            onConfirm={() => {
              if (busy) return;
              const pending = pendingNavigation;
              discardDrafts();
              setConfirmExit(false);
              setPendingNavigation(null);
              if (pending) {
                openScreen('overview');
                pending.navigate();
              } else onClose();
            }}
          />
        </Suspense>
      )}
    </>
  );
}
