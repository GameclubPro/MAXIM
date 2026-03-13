import { useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
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

  const raw = error.message.trim();
  if (!raw) {
    return fallback;
  }

  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      return raw;
    }
  }

  return raw.replace(/^API request failed:\s*\d+\s*/u, '').trim() || fallback;
}

function canWriteImageClipboard(): boolean {
  const clipboard = navigator.clipboard;
  const clipboardItemCtor = (window as Window & { ClipboardItem?: unknown }).ClipboardItem;
  return typeof clipboard?.write === 'function' && typeof clipboardItemCtor === 'function';
}

async function writeImageToClipboard(
  blob: Blob,
  mimeType: string,
  dataUrl: string,
): Promise<'rich' | 'image' | null> {
  if (!canWriteImageClipboard()) {
    return null;
  }

  const ClipboardItemCtor = (
    window as Window & {
      ClipboardItem?: new (items: Record<string, Blob>) => unknown;
    }
  ).ClipboardItem;
  if (!ClipboardItemCtor) {
    return null;
  }

  const html = `<img src="${dataUrl}" width="512" height="512" alt="sticker" />`;
  try {
    await (navigator.clipboard as { write: (items: unknown[]) => Promise<void> }).write([
      new ClipboardItemCtor({
        [mimeType]: blob,
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([' '], { type: 'text/plain' }),
      }),
    ]);
    return 'rich';
  } catch {
    try {
      await (navigator.clipboard as { write: (items: unknown[]) => Promise<void> }).write([
        new ClipboardItemCtor({ [mimeType]: blob }),
      ]);
      return 'image';
    } catch {
      return null;
    }
  }
}

function copyImageWithExecCommand(dataUrl: string): boolean {
  const container = document.createElement('div');
  const imageHtml = `<img src="${dataUrl}" width="512" height="512" alt="sticker" />`;
  container.contentEditable = 'true';
  container.style.position = 'fixed';
  container.style.opacity = '0';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  container.innerHTML = imageHtml;
  document.body.appendChild(container);

  const onCopy = (event: Event) => {
    const clipboardEvent = event as ClipboardEvent;
    if (!clipboardEvent.clipboardData) {
      return;
    }
    clipboardEvent.clipboardData.setData('text/html', imageHtml);
    clipboardEvent.clipboardData.setData('text/plain', ' ');
    clipboardEvent.preventDefault();
  };
  container.addEventListener('copy', onCopy);

  const selection = window.getSelection();
  if (!selection) {
    container.removeEventListener('copy', onCopy);
    document.body.removeChild(container);
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    selection.removeAllRanges();
    container.removeEventListener('copy', onCopy);
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
        title: 'Готово',
        description: 'Изображение подготовлено. Нажмите «Скопировать».',
      });
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'Не удалось подготовить изображение. Попробуйте другое фото.',
      );
      setPrepared(null);
      setPickerError(message);
    } finally {
      setIsPreparing(false);
    }
  }

  async function fileFromDataUrl(dataUrl: string): Promise<File | null> {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      if (!blob.type.toLowerCase().startsWith('image/')) {
        return null;
      }

      const extension =
        blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      return new File([blob], `pasted-image.${extension}`, { type: blob.type });
    } catch {
      return null;
    }
  }

  function extractDataImageUrl(html: string): string | null {
    const match = html.match(/src=["'](data:image\/[^"']+)["']/iu);
    if (!match || typeof match[1] !== 'string') {
      return null;
    }

    const dataUrl = match[1].trim();
    return dataUrl.length > 0 ? dataUrl : null;
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLDivElement>): Promise<void> {
    const clipboard = event.clipboardData;
    const imageItem = Array.from(clipboard.items).find(
      (item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'),
    );

    if (imageItem) {
      event.preventDefault();
      await handleFilePick(imageItem.getAsFile());
      return;
    }

    const html = clipboard.getData('text/html');
    const dataUrl = extractDataImageUrl(html);
    if (!dataUrl) {
      return;
    }

    event.preventDefault();
    const fileFromHtml = await fileFromDataUrl(dataUrl);
    await handleFilePick(fileFromHtml);
  }

  async function handleCopyPreparedImage(): Promise<void> {
    if (!prepared || isCopying || isPreparing) {
      return;
    }

    setIsCopying(true);
    setPickerError(null);

    try {
      const clipboardAsset = await prepareStickerClipboardImage(prepared);
      const clipboardWriteMode = await writeImageToClipboard(
        clipboardAsset.blob,
        clipboardAsset.mimeType,
        clipboardAsset.dataUrl,
      );
      const copied = clipboardWriteMode !== null || copyImageWithExecCommand(clipboardAsset.dataUrl);
      if (!copied) {
        throw new Error('Не удалось скопировать изображение в буфер обмена.');
      }

      pushToast({
        tone: 'success',
        title: 'Скопировано',
        description:
          clipboardWriteMode === 'rich'
            ? 'Вставьте изображение в личку с ботом в MAX.'
            : 'Вставьте в MAX. Если не вставилось, сделайте долгое нажатие по превью и «Скопировать».',
      });
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'Не удалось скопировать изображение. Попробуйте ещё раз.',
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
      <GlassCard className="sticker-lab-card sticker-lab-card--upload" elevated>
        <div className="sticker-lab-card__head">
          <div>
            <h2>Стикеры</h2>
          </div>
        </div>

        <label className="sticker-lab-dropzone">
          <span className="sticker-lab-dropzone__eyebrow">Загрузка</span>
          <strong>Загрузите любое изображение</strong>
          <small>Mini App подготовит PNG 512×512 для вставки в MAX.</small>
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

        <div className="sticker-lab-paste">
          <span className="sticker-lab-paste__label">Вставка</span>
          <div
            className="sticker-lab-paste__editor"
            role="textbox"
            aria-multiline="true"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Вставьте изображение из буфера"
            onPaste={(event) => {
              void handlePaste(event);
            }}
          />
        </div>

        {isPreparing ? <StatusState tone="neutral" title="Готовим..." /> : null}

        {prepared ? (
          <div className="sticker-lab-preview">
            <div className="sticker-lab-preview__media">
              <img src={prepared.previewDataUrl} alt="Подготовленный макет стикера." />
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
            {isCopying ? 'Копируем...' : 'Скопировать'}
          </button>
          <Link to="/" className="button button--ghost">
            К чатам
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
