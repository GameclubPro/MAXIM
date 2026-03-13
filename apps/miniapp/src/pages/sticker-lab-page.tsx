import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  prepareStickerClipboardImage,
  prepareStickerImage,
  type PreparedStickerClipboardImage,
  type PreparedStickerImage,
} from '../lib/sticker-image';

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const message = error.message.trim();
  return message || fallback;
}

function canWriteImageClipboard(): boolean {
  const clipboard = navigator.clipboard;
  const clipboardItemCtor = (window as Window & { ClipboardItem?: unknown }).ClipboardItem;
  return typeof clipboard?.write === 'function' && typeof clipboardItemCtor === 'function';
}

function isIosDevice(): boolean {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchPoints = navigator.maxTouchPoints || 0;
  const iOSByUA = /iPad|iPhone|iPod/u.test(ua);
  const iPadDesktopMode = platform === 'MacIntel' && touchPoints > 1;
  return iOSByUA || iPadDesktopMode;
}

function isPngMimeType(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'image/png';
}

async function writePngToClipboard(blob: Blob, dataUrl: string): Promise<boolean> {
  if (!canWriteImageClipboard()) {
    return false;
  }
  if (!isPngMimeType(blob.type)) {
    return false;
  }

  const ClipboardItemCtor = (
    window as Window & {
      ClipboardItem?: new (items: Record<string, unknown>) => unknown;
    }
  ).ClipboardItem;
  if (!ClipboardItemCtor) {
    return false;
  }

  const clipboard = navigator.clipboard as { write: (items: unknown[]) => Promise<void> };
  const html = `<img src="${dataUrl}" alt="Sticker PNG" width="512" height="512">`;
  const attempts: Array<Record<string, Blob | Promise<Blob>>> = [
    { 'image/png': blob },
    { 'image/png': Promise.resolve(blob) },
    {
      'image/png': blob,
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([dataUrl], { type: 'text/plain' }),
    },
    {
      'image/png': Promise.resolve(blob),
      'text/html': Promise.resolve(new Blob([html], { type: 'text/html' })),
      'text/plain': Promise.resolve(new Blob([dataUrl], { type: 'text/plain' })),
    },
  ];

  for (const payload of attempts) {
    try {
      await clipboard.write([new ClipboardItemCtor(payload)]);
      return true;
    } catch {
      // Try next payload variant for better browser compatibility.
    }
  }

  return false;
}

function copyImageWithExecCommand(dataUrl: string): boolean {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  container.style.position = 'fixed';
  container.style.left = '0';
  container.style.top = '0';
  container.style.width = '1px';
  container.style.height = '1px';
  container.style.opacity = '0.01';
  container.style.overflow = 'hidden';
  container.style.pointerEvents = 'none';
  container.style.zIndex = '-1';

  const image = document.createElement('img');
  image.src = dataUrl;
  image.width = 512;
  image.height = 512;
  image.alt = 'Sticker PNG';
  container.appendChild(image);
  document.body.appendChild(container);

  const selection = window.getSelection();
  if (!selection) {
    document.body.removeChild(container);
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);
  container.focus();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    selection.removeAllRanges();
    document.body.removeChild(container);
  }

  return copied;
}

export function StickerLabPage() {
  const { pushToast } = useToast();
  const [prepared, setPrepared] = useState<PreparedStickerImage | null>(null);
  const [preparedClipboard, setPreparedClipboard] = useState<PreparedStickerClipboardImage | null>(
    null,
  );
  const [isPreparing, setIsPreparing] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [fallbackPreviewSrc, setFallbackPreviewSrc] = useState<string | null>(null);
  const iosDevice = isIosDevice();

  useEffect(() => {
    return () => {
      if (fallbackPreviewSrc?.startsWith('blob:')) {
        URL.revokeObjectURL(fallbackPreviewSrc);
      }
    };
  }, [fallbackPreviewSrc]);

  async function handleFilePick(file: File | null) {
    if (!file) {
      return;
    }

    setIsPreparing(true);
    setFallbackPreviewSrc((current) => {
      if (current?.startsWith('blob:')) {
        URL.revokeObjectURL(current);
      }
      return null;
    });

    try {
      const nextPrepared = await prepareStickerImage(file);
      const nextPreparedClipboard = await prepareStickerClipboardImage(nextPrepared);
      setPrepared(nextPrepared);
      setPreparedClipboard(nextPreparedClipboard);
      pushToast({
        tone: 'success',
        title: 'PNG готов',
      });
    } catch (error: unknown) {
      setPrepared(null);
      setPreparedClipboard(null);
      pushToast({
        tone: 'danger',
        title: normalizeErrorMessage(error, 'Не удалось подготовить'),
      });
    } finally {
      setIsPreparing(false);
    }
  }

  async function handleCopyPreparedImage(): Promise<void> {
    if (!prepared || !preparedClipboard || isPreparing || isCopying) {
      return;
    }

    setIsCopying(true);

    try {
      const copied =
        (await writePngToClipboard(preparedClipboard.blob, preparedClipboard.dataUrl)) ||
        copyImageWithExecCommand(preparedClipboard.dataUrl);
      if (copied) {
        pushToast({
          tone: 'success',
          title: 'Скопировано',
        });
        return;
      }

      if (iosDevice) {
        const objectUrl = URL.createObjectURL(preparedClipboard.blob);
        setFallbackPreviewSrc((current) => {
          if (current?.startsWith('blob:')) {
            URL.revokeObjectURL(current);
          }
          return objectUrl;
        });
        pushToast({
          tone: 'info',
          title: 'iOS WebView не дал скопировать PNG',
        });
        return;
      }

      throw new Error('Не удалось скопировать');
    } catch (error: unknown) {
      pushToast({
        tone: 'danger',
        title: normalizeErrorMessage(error, 'Не удалось скопировать'),
      });
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <div className="page-stack page-enter sticker-lab-page">
      <GlassCard className="sticker-lab-card" elevated>
        <div className="sticker-lab-card__head">
          <div>
            <h2>Стикеры</h2>
          </div>
        </div>

        <label className="sticker-lab-dropzone">
          <strong>{prepared ? 'Загрузить другую' : 'Загрузить'}</strong>
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              void handleFilePick(file);
              event.currentTarget.value = '';
            }}
          />
        </label>

        {isPreparing ? <StatusState tone="neutral" title="Готовим PNG..." /> : null}

        {prepared ? (
          <div className="sticker-lab-preview">
            <div className="sticker-lab-preview__media">
              <img src={prepared.previewDataUrl} alt="Подготовленный PNG для вставки в MAX." />
            </div>
          </div>
        ) : null}

        <div className="sticker-lab-primary-action">
          <button
            type="button"
            className="button button--accent sticker-lab-primary-action__button"
            onClick={() => void handleCopyPreparedImage()}
            disabled={!prepared || !preparedClipboard || isPreparing || isCopying}
          >
            {isCopying ? 'Копируем...' : 'Копировать'}
          </button>
        </div>
        <Link to="/" className="sticker-lab-backlink">
          К чатам
        </Link>
      </GlassCard>

      {fallbackPreviewSrc ? (
        <div
          className="sticker-lab-viewer"
          role="dialog"
          aria-modal="true"
          onClick={() => setFallbackPreviewSrc(null)}
        >
          <button
            type="button"
            className="sticker-lab-viewer__close"
            onClick={(event) => {
              event.stopPropagation();
              setFallbackPreviewSrc(null);
            }}
            aria-label="Закрыть"
          >
            ×
          </button>
          <a
            href={fallbackPreviewSrc}
            target="_blank"
            rel="noreferrer"
            className="sticker-lab-viewer__surface"
            onClick={(event) => event.stopPropagation()}
          >
            <img src={fallbackPreviewSrc} alt="PNG" className="sticker-lab-viewer__image" />
          </a>
        </div>
      ) : null}
    </div>
  );
}
