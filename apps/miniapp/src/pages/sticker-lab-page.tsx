import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import type { ApiClient } from '../lib/api-client';
import { canShareMaxContent, openMaxBotLink, shareMaxContent } from '../lib/max-bridge';
import { prepareStickerImage, type PreparedStickerImage } from '../lib/sticker-image';

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

export function StickerLabPage({ api }: StickerLabPageProps) {
  const { pushToast } = useToast();
  const [prepared, setPrepared] = useState<PreparedStickerImage | null>(null);
  const [sentAsset, setSentAsset] = useState<SentStickerLabAsset | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isSending, setIsSending] = useState(false);
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

  return (
    <div className="page-stack page-enter sticker-lab-page">
      <GlassCard className="sticker-lab-hero" elevated>
        <div className="sticker-lab-hero__copy">
          <span className="chip">MAX Bridge</span>
          <h1>Стикер-лаб</h1>
          <p>
            Загружаете фото, mini app собирает квадратный WEBP 512×512, бот отправляет его в
            личку, а MAX открывает native share.
          </p>
        </div>

        <ol className="sticker-lab-hero__steps">
          <li>Выберите фото из галереи или камеры.</li>
          <li>Проверьте превью и отправьте его боту.</li>
          <li>Поделитесь сообщением от бота в нужный чат MAX.</li>
        </ol>
      </GlassCard>

      <GlassCard className="sticker-lab-card sticker-lab-card--upload" elevated>
        <div className="sticker-lab-card__head">
          <div>
            <h2>Макет</h2>
            <p>Лучше всего работают крупные портреты и фото с одним главным объектом.</p>
          </div>
          {prepared ? <span className="chip chip--success">512×512 WEBP</span> : null}
        </div>

        <label className="sticker-lab-dropzone">
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              void handleFilePick(event.target.files?.[0] ?? null);
              event.currentTarget.value = '';
            }}
          />
          <span className="sticker-lab-dropzone__eyebrow">
            {prepared ? 'Заменить изображение' : 'Загрузить изображение'}
          </span>
          <strong>{prepared ? 'Выбрать другое фото' : 'Нажмите, чтобы выбрать фото'}</strong>
          <small>Поддерживаются обычные изображения. GIF и видео сюда не подойдут.</small>
        </label>

        {isPreparing ? (
          <StatusState
            tone="neutral"
            title="Готовим превью"
            description="Собираем sticker-like карточку для отправки в MAX."
          />
        ) : null}

        {prepared ? (
          <div className="sticker-lab-preview">
            <div className="sticker-lab-preview__media">
              <img src={prepared.previewDataUrl} alt="Подготовленный макет стикера." />
            </div>
            <div className="sticker-lab-preview__meta">
              <div className="sticker-lab-preview__meta-row">
                <span className="chip">{prepared.fileName}</span>
                <span className="chip">{prepared.width}×{prepared.height}</span>
              </div>
              <p>
                Это изображение бот отправит вам в личный чат. Дальше MAX откроет системный экран
                шеринга.
              </p>
            </div>
          </div>
        ) : null}

        {pickerError ? <small className="field__hint">{pickerError}</small> : null}

        <div className="sticker-lab-actions">
          <button
            type="button"
            className="button button--accent"
            onClick={() => void handleSend()}
            disabled={!prepared || isPreparing || isSending}
          >
            {isSending
              ? 'Отправляем...'
              : bridgeAvailable
                ? 'Отправить и открыть шеринг'
                : 'Отправить боту'}
          </button>
          <Link to="/" className="button button--ghost">
            К чатам
          </Link>
        </div>
      </GlassCard>

      {sentAsset ? (
        <GlassCard className="sticker-lab-card" elevated>
          <StatusState
            tone="success"
            title="Сообщение уже у бота"
            description="Можно открыть это сообщение в MAX или заново вызвать native share."
          />

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

      <GlassCard className="sticker-lab-card" padding="sm">
        <StatusState
          tone="neutral"
          title="Важно"
          description="Если MAX ещё не знает вашу личку с ботом, сначала откройте её и отправьте боту любое сообщение."
        />
      </GlassCard>
    </div>
  );
}
