import { useState } from 'react';
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
  const [pickerError, setPickerError] = useState<string | null>(null);
  const iosDevice = isIosDevice();

  async function handleFilePick(file: File | null) {
    if (!file) {
      return;
    }

    setIsPreparing(true);
    setPickerError(null);

    try {
      const nextPrepared = await prepareStickerImage(file);
      setPrepared(nextPrepared);
      pushToast({
        tone: 'success',
        title: 'PNG готов',
        description: 'Теперь нажмите «Получить стикер».',
      });
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'Не удалось подготовить PNG. Попробуйте другое изображение.',
      );
      setPrepared(null);
      setPickerError(message);
    } finally {
      setIsPreparing(false);
    }
  }

  async function handleCopyPreparedImage(): Promise<void> {
    if (!prepared || isPreparing || isCopying) {
      return;
    }

    setIsCopying(true);
    setPickerError(null);

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
          description: 'Вставьте PNG в диалог MAX.',
        });
        return;
      }

      if (iosDevice) {
        const shared = await openNativeShare(shareFile);
        if (shared) {
          pushToast({
            tone: 'info',
            title: 'Открыто меню iPhone',
            description: 'В системном меню выберите «Скопировать».',
          });
          return;
        }
      }

      throw new Error(
        'Буфер обмена не дал записать PNG. Нажмите и удерживайте превью ниже и выберите «Скопировать».',
      );
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'Не удалось скопировать PNG. Попробуйте ещё раз.',
      );
      setPickerError(message);
      pushToast({
        tone: 'danger',
        title: 'Копирование не удалось',
        description: message,
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
            <h2>Получить стикер</h2>
            <p>Загрузите картинку и скопируйте PNG 512×512.</p>
          </div>
        </div>

        <label className="sticker-lab-dropzone">
          <strong>{prepared ? 'Загрузить другую картинку' : 'Загрузить картинку'}</strong>
          <small>Mini App соберет PNG 512×512 для вставки в MAX.</small>
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
            <div className="sticker-lab-preview__meta">
              <div className="sticker-lab-preview__badges">
                <span className="chip">PNG</span>
                <span className="chip">512×512</span>
              </div>
              <p>
                {iosDevice
                  ? 'Нажмите кнопку ниже, чтобы сразу попробовать скопировать PNG на iPhone.'
                  : 'Нажмите кнопку ниже и вставьте PNG в диалог с ботом в MAX.'}
              </p>
            </div>
          </div>
        ) : null}

        {pickerError ? <small className="field__hint">{pickerError}</small> : null}

        <div className="sticker-lab-primary-action">
          <button
            type="button"
            className="button button--accent sticker-lab-primary-action__button"
            onClick={() => void handleCopyPreparedImage()}
            disabled={!prepared || isPreparing || isCopying}
          >
            {isCopying ? 'Копируем...' : iosDevice ? 'Скопировать на iPhone' : 'Скопировать PNG'}
          </button>
          <small className="sticker-lab-primary-action__hint">
            {iosDevice
              ? 'Кнопка пробует прямое копирование PNG. Если iPhone не даст доступ к буферу, откроется системное меню.'
              : 'Кнопка копирует PNG 512×512 в буфер обмена.'}
          </small>
        </div>
        <Link to="/" className="sticker-lab-backlink">
          К чатам
        </Link>
      </GlassCard>
    </div>
  );
}
