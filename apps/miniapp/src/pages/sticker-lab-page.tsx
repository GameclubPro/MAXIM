import { useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import type { ApiClient } from '../lib/api-client';
import { canShareMaxContent, openMaxBotLink, shareMaxContent } from '../lib/max-bridge';
import {
  prepareStickerClipboardImage,
  prepareStickerImage,
  type PreparedStickerImage,
} from '../lib/sticker-image';

type StickerLabPageProps = {
  api: ApiClient;
};

type SentStickerLabAsset = Awaited<ReturnType<ApiClient['shareStickerLabImage']>>;

const SHARE_DELAY_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

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
  container.style.opacity = '0';
  container.style.left = '-9999px';
  container.style.top = '-9999px';

  const image = document.createElement('img');
  image.src = dataUrl;
  image.width = 512;
  image.height = 512;
  image.alt = 'sticker';
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

export function StickerLabPage({ api }: StickerLabPageProps) {
  const { pushToast } = useToast();
  const [prepared, setPrepared] = useState<PreparedStickerImage | null>(null);
  const [sentAsset, setSentAsset] = useState<SentStickerLabAsset | null>(null);
  const [deliveryType, setDeliveryType] = useState<'file' | 'image'>('file');
  const [isPreparing, setIsPreparing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const bridgeAvailable = canShareMaxContent();

  async function handleFilePick(file: File | null) {
    if (!file) {
      return;
    }

    setIsPreparing(true);
    setPickerError(null);

    try {
      const nextPrepared = await prepareStickerImage(file);
      setPrepared(nextPrepared);
      setSentAsset(null);
      pushToast({
        tone: 'success',
        title: 'Макет готов',
        description: 'Теперь можно отправить его в личку с ботом и открыть native share.',
      });
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'Не удалось подготовить изображение. Попробуйте другое фото.',
      );
      setPrepared(null);
      setSentAsset(null);
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

  async function handleShareOnceMore(asset: SentStickerLabAsset) {
    if (!bridgeAvailable) {
      if (asset.messageUrl) {
        openMaxBotLink(asset.messageUrl);
        return;
      }

      pushToast({
        tone: 'info',
        title: 'Native share недоступен',
        description: 'Откройте MAX в приложении, чтобы поделиться сообщением от бота.',
      });
      return;
    }

    try {
      await wait(SHARE_DELAY_MS);
      await shareMaxContent({
        mid: asset.mid,
        chatType: 'DIALOG',
      });
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'MAX не открыл экран шеринга. Попробуйте ещё раз.',
      );
      pushToast({
        tone: 'info',
        title: 'Не удалось открыть шеринг',
        description: message,
      });
    }
  }

  async function handleSend(): Promise<void> {
    if (!prepared) {
      return;
    }

    setIsSending(true);
    setPickerError(null);

    try {
      const result = await api.shareStickerLabImage({
        imageBase64: prepared.base64,
        imageMimeType: prepared.mimeType,
        imageFileName: prepared.fileName,
        deliveryType,
      });
      setSentAsset(result);
      pushToast({
        tone: 'success',
        title: 'Отправлено в личку с ботом',
        description: bridgeAvailable
          ? 'MAX сейчас откроет native share.'
          : 'Сообщение уже у бота. Если нужно, откройте его вручную.',
      });
      await handleShareOnceMore(result);
    } catch (error: unknown) {
      const message = normalizeErrorMessage(
        error,
        'Не удалось отправить изображение боту. Попробуйте ещё раз.',
      );
      setPickerError(message);
      pushToast({
        tone: 'danger',
        title: 'Отправка не удалась',
        description: message,
      });
    } finally {
      setIsSending(false);
    }
  }

  async function handleCopyPreparedImage(): Promise<void> {
    if (!prepared || isCopying) {
      return;
    }

    setIsCopying(true);
    setPickerError(null);

    try {
      const clipboardAsset = await prepareStickerClipboardImage(prepared);
      const copiedWithClipboardApi = await writeImageToClipboard(
        clipboardAsset.blob,
        clipboardAsset.mimeType,
      );
      const copied =
        copiedWithClipboardApi || copyImageWithExecCommand(clipboardAsset.dataUrl);
      if (!copied) {
        throw new Error('Не удалось скопировать изображение в буфер обмена.');
      }

      pushToast({
        tone: 'success',
        title: 'Скопировано',
        description: 'Теперь вставьте изображение в личку с ботом в MAX.',
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

        <div className="sticker-lab-paste">
          <span className="sticker-lab-paste__label">Вставка</span>
          <div
            className="sticker-lab-paste__editor"
            role="textbox"
            aria-multiline="true"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Вставьте текст или изображение из буфера"
            onPaste={(event) => {
              void handlePaste(event);
            }}
          />
        </div>

        <div className="sticker-lab-mode">
          <button
            type="button"
            className={deliveryType === 'file' ? 'button button--accent' : 'button button--ghost'}
            onClick={() => setDeliveryType('file')}
            disabled={isSending}
          >
            Как файл
          </button>
          <button
            type="button"
            className={deliveryType === 'image' ? 'button button--accent' : 'button button--ghost'}
            onClick={() => setDeliveryType('image')}
            disabled={isSending}
          >
            Как картинку
          </button>
        </div>

        {isPreparing ? (
          <StatusState tone="neutral" title="Готовим..." />
        ) : null}

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
            onClick={() => void handleSend()}
            disabled={!prepared || isPreparing || isSending || isCopying}
          >
            {isSending
              ? 'Отправляем...'
              : bridgeAvailable
                ? deliveryType === 'file'
                  ? 'Отправить файлом и открыть шеринг'
                  : 'Отправить картинкой и открыть шеринг'
                : deliveryType === 'file'
                  ? 'Отправить файлом боту'
                  : 'Отправить картинкой боту'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void handleCopyPreparedImage()}
            disabled={!prepared || isPreparing || isSending || isCopying}
          >
            {isCopying ? 'Копируем...' : 'Скопировать для вставки в MAX'}
          </button>
          <Link to="/" className="button button--ghost">
            К чатам
          </Link>
        </div>
      </GlassCard>

      {sentAsset ? (
        <GlassCard className="sticker-lab-card" elevated>
          <StatusState tone="success" title="Отправлено" />

          <div className="sticker-lab-actions">
            <button
              type="button"
              className="button button--accent"
              onClick={() => void handleShareOnceMore(sentAsset)}
            >
              {bridgeAvailable ? 'Поделиться ещё раз' : 'Открыть в MAX'}
            </button>
            {sentAsset.messageUrl ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => openMaxBotLink(sentAsset.messageUrl ?? '')}
              >
                Открыть сообщение
              </button>
            ) : null}
          </div>
        </GlassCard>
      ) : null}
    </div>
  );
}
