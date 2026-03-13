import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  prepareStickerClipboardImage,
  prepareStickerImage,
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

function canShareImageFile(file: File): boolean {
  const shareFn = navigator.share;
  const canShareFn = (navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
  }).canShare;

  if (typeof shareFn !== 'function') {
    return false;
  }

  try {
    if (typeof canShareFn !== 'function') {
      return true;
    }
    return canShareFn({ files: [file] });
  } catch {
    return false;
  }
}

async function openNativeShare(file: File): Promise<boolean> {
  if (!canShareImageFile(file) || typeof navigator.share !== 'function') {
    return false;
  }

  try {
    await navigator.share({
      title: 'Sticker PNG',
      files: [file],
    });
    return true;
  } catch {
    return false;
  }
}

async function writeImageToClipboard(blob: Blob, mimeType: string): Promise<boolean> {
  if (!canWriteImageClipboard()) {
    return false;
  }

  const ClipboardItemCtor = (
    window as Window & {
      ClipboardItem?: new (items: Record<string, Blob>) => unknown;
    }
  ).ClipboardItem;
  if (!ClipboardItemCtor) {
    return false;
  }

  try {
    await (navigator.clipboard as { write: (items: unknown[]) => Promise<void> }).write([
      new ClipboardItemCtor({ [mimeType]: blob }),
    ]);
    return true;
  } catch {
    return false;
  }
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

    try {
      const nextPrepared = await prepareStickerImage(file);
      setPrepared(nextPrepared);
      pushToast({
        tone: 'success',
        title: 'PNG готов',
      });
    } catch (error: unknown) {
      setPrepared(null);
      pushToast({
        tone: 'danger',
        title: normalizeErrorMessage(error, 'Не удалось подготовить'),
      });
    } finally {
      setIsPreparing(false);
    }
  }

  async function handleCopyPreparedImage(): Promise<void> {
    if (!prepared || isPreparing || isCopying) {
      return;
    }

    setIsCopying(true);

    try {
      const clipboardAsset = await prepareStickerClipboardImage(prepared);
      const shareFile = new File([clipboardAsset.blob], clipboardAsset.fileName, {
        type: clipboardAsset.mimeType,
      });
      const copied = await writeImageToClipboard(
        clipboardAsset.blob,
        clipboardAsset.mimeType,
      );

      if (copied || copyImageWithExecCommand(clipboardAsset.dataUrl)) {
        pushToast({
          tone: 'success',
          title: 'Скопировано',
        });
        return;
      }

      if (iosDevice) {
        const shared = await openNativeShare(shareFile);
        if (shared) {
          pushToast({
            tone: 'info',
            title: 'Открыто меню',
          });
          return;
        }

        const objectUrl = URL.createObjectURL(clipboardAsset.blob);
        setFallbackPreviewSrc((current) => {
          if (current?.startsWith('blob:')) {
            URL.revokeObjectURL(current);
          }
          return objectUrl;
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
            disabled={!prepared || isPreparing || isCopying}
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
