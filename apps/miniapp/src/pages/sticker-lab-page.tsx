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
              <p>После кнопки вставьте изображение в диалог с ботом в MAX.</p>
            </div>
          </div>
        ) : null}

        {pickerError ? <small className="field__hint">{pickerError}</small> : null}

        <div className="sticker-lab-actions">
          <button
            type="button"
            className="button button--accent"
            onClick={() => void handleCopyPreparedImage()}
            disabled={!prepared || isPreparing || isCopying}
          >
            {isCopying ? 'Копируем...' : 'Получить стикер'}
          </button>
          <Link to="/" className="button button--ghost">
            К чатам
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
