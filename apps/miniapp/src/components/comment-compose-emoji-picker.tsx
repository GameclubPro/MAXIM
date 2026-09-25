import { Xmark } from 'iconoir-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { maxImpact } from '../lib/max-bridge';

const GROUPS = [
  { id: 'frequent', label: 'Частые', emojis: ['👍', '❤️', '😂', '🔥', '👏', '😍', '🎉', '💯'] },
  { id: 'faces', label: 'Лица', emojis: ['😊', '😎', '🤔', '😮', '😢', '😡', '😇', '🙌'] },
  { id: 'gestures', label: 'Жесты', emojis: ['👌', '🤝', '🙏', '💪', '👀', '✅', '❌', '⭐'] },
  { id: 'symbols', label: 'Символы', emojis: ['🚀', '⚡', '✨', '💬', '📌', '📎', '🧠', '🫶'] },
] as const;

export default function CommentComposeEmojiPicker({
  onSelect,
  onClose,
}: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const [activeGroup, setActiveGroup] = useState<(typeof GROUPS)[number]>(GROUPS[0]);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const surface = panel?.parentElement;
    const header = panel
      ?.closest('.channel-dialog-screen')
      ?.querySelector('.channel-dialog-comments-header');
    if (!panel || !surface || !header) return;
    const update = () => {
      const headerBottom = header.getBoundingClientRect().bottom;
      const bounds = surface.getBoundingClientRect();
      const above = bounds.top - headerBottom - 10;
      const viewport = window.visualViewport;
      const visibleBottom = Math.min(
        bounds.bottom,
        viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
      );
      const useAbove = above >= 180 && bounds.top < visibleBottom;
      panel.style.bottom = useAbove
        ? 'calc(100% + 7px)'
        : `${Math.max(0, bounds.bottom - visibleBottom)}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(280, useAbove ? above : visibleBottom - headerBottom - 10))}px`;
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(surface);
    observer?.observe(header);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      id="channel-dialog-compose-emoji-panel"
      className="channel-dialog-compose__emoji-panel"
      role="group"
      aria-label="Эмодзи"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="channel-dialog-compose__emoji-head">
        <span className="channel-dialog-compose__emoji-handle" aria-hidden />
        <button
          type="button"
          className="channel-dialog-compose__emoji-close"
          aria-label="Закрыть эмодзи"
          onClick={() => {
            maxImpact('light');
            onClose();
          }}
        >
          <Xmark aria-hidden />
        </button>
      </div>
      <div className="channel-dialog-compose__emoji-tabs" role="group" aria-label="Группа эмодзи">
        {GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            className={cn(
              'channel-dialog-compose__emoji-tab',
              group.id === activeGroup.id && 'is-active',
            )}
            aria-pressed={group.id === activeGroup.id}
            onClick={() => setActiveGroup(group)}
          >
            {group.label}
          </button>
        ))}
      </div>
      <div className="channel-dialog-compose__emoji-grid" role="group" aria-label="Выбор эмодзи">
        {activeGroup.emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="channel-dialog-compose__emoji"
            onClick={() => onSelect(emoji)}
            aria-label={`Добавить ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
