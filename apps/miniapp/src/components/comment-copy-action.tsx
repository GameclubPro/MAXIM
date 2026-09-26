import { Copy } from 'iconoir-react';
import { useEffect, useRef, useState } from 'react';
import { copyCommentText } from '../lib/copy-comment-text';
import { useToast } from './ui/toast';

export default function CommentCopyAction({
  text,
  onCopied,
}: {
  text: string;
  onCopied: () => void;
}) {
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { pushToast } = useToast();
  return (
    <button
      type="button"
      className="channel-dialog-reaction-popover__action"
      disabled={pending}
      onClick={async (event) => {
        const owner = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
        if (pending || !owner) return;
        setPending(true);
        try {
          await copyCommentText(text, owner);
          if (!active.current) return;
          pushToast({ tone: 'success', title: 'Текст скопирован' });
          onCopied();
        } catch {
          if (!active.current) return;
          pushToast({ tone: 'danger', title: 'Не удалось скопировать текст' });
        } finally {
          if (active.current) setPending(false);
        }
      }}
    >
      <Copy aria-hidden />
      Копировать
    </button>
  );
}
