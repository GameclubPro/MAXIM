import { CheckCircle, OpenNewWindow, Play } from 'iconoir-react';
import { cn } from '../../lib/cn';

const DIRECT_VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|ogg|ogv)$/iu;
const DIRECT_VIDEO_TOKEN_PATTERN = /(^|[./_-])(mp4|m4v|mov|webm|ogg|ogv)([./_-]|$)/iu;

function parseVideoUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function readVideoPath(url: string): string {
  const parsed = parseVideoUrl(url);
  if (!parsed) {
    return url;
  }

  try {
    return decodeURIComponent(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return `${parsed.hostname}${parsed.pathname}`;
  }
}

export function isDirectVkParsingVideoUrl(url: string): boolean {
  const parsed = parseVideoUrl(url);
  if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const path = readVideoPath(url);
  return DIRECT_VIDEO_EXTENSION_PATTERN.test(path) || DIRECT_VIDEO_TOKEN_PATTERN.test(path);
}

function resolveVideoMimeType(url: string): string | undefined {
  const path = readVideoPath(url).toLowerCase();
  if (path.includes('webm')) {
    return 'video/webm';
  }
  if (path.includes('ogg') || path.includes('ogv')) {
    return 'video/ogg';
  }
  if (path.includes('mov')) {
    return 'video/quicktime';
  }
  if (path.includes('mp4') || path.includes('m4v')) {
    return 'video/mp4';
  }

  return undefined;
}

function formatVideoSourceLabel(url: string): string {
  const parsed = parseVideoUrl(url);
  if (!parsed) {
    return 'VK';
  }

  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1];
  if (fileName && DIRECT_VIDEO_EXTENSION_PATTERN.test(fileName)) {
    try {
      return decodeURIComponent(fileName);
    } catch {
      return fileName;
    }
  }

  return parsed.hostname.replace(/^www\./iu, '');
}

function VideoPoster() {
  return (
    <span className="vk-parsing-video-preview__poster" aria-hidden>
      <span className="vk-parsing-video-preview__play">
        <Play aria-hidden />
      </span>
      <span className="vk-parsing-video-preview__rail" />
      <span className="vk-parsing-video-preview__rail" />
    </span>
  );
}

function VideoMeta({ url, index, selected }: { url: string; index: number; selected?: boolean }) {
  const label = index > 0 ? `Видео ${index + 1}` : 'Видео';
  const sourceLabel = formatVideoSourceLabel(url);

  return (
    <span className="vk-parsing-video-preview__meta">
      <span className="vk-parsing-video-preview__title">
        {selected ? <CheckCircle aria-hidden /> : <Play aria-hidden />}
        <strong>{label}</strong>
      </span>
      <span className="vk-parsing-video-preview__source">{sourceLabel}</span>
    </span>
  );
}

type PostVideoPreviewProps = {
  url: string;
  index?: number;
};

export function PostVideoPreview({ url, index = 0 }: PostVideoPreviewProps) {
  const isDirect = isDirectVkParsingVideoUrl(url);

  if (!isDirect) {
    return (
      <a
        className="vk-parsing-video-preview vk-parsing-video-preview--card is-external"
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label="Открыть видео VK"
        title="Открыть видео VK"
      >
        <VideoPoster />
        <VideoMeta url={url} index={index} />
        <span className="vk-parsing-video-preview__open" aria-hidden>
          <OpenNewWindow aria-hidden />
        </span>
      </a>
    );
  }

  return (
    <div className="vk-parsing-video-preview vk-parsing-video-preview--card is-direct">
      <div className="vk-parsing-video-preview__player">
        <video controls preload="metadata" playsInline aria-label="Видео VK">
          <source src={url} type={resolveVideoMimeType(url)} />
        </video>
      </div>
      <div className="vk-parsing-video-preview__footer">
        <VideoMeta url={url} index={index} />
        <a
          className="vk-parsing-video-preview__open"
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть видео VK"
          title="Открыть видео VK"
        >
          <OpenNewWindow aria-hidden />
        </a>
      </div>
    </div>
  );
}

type PostVideoChoiceProps = {
  url: string;
  index: number;
  checked: boolean;
  disabled: boolean;
  onToggle: (url: string) => void;
};

export function PostVideoChoice({ url, index, checked, disabled, onToggle }: PostVideoChoiceProps) {
  const isDirect = isDirectVkParsingVideoUrl(url);

  return (
    <div
      className={cn('vk-parsing-video-choice', checked && 'is-selected', disabled && 'is-disabled')}
    >
      <button
        type="button"
        className="vk-parsing-video-choice__select"
        aria-pressed={checked}
        aria-label={`${checked ? 'Убрать' : 'Вернуть'} видео ${index + 1}`}
        title={checked ? 'Убрать видео' : 'Вернуть видео'}
        disabled={disabled}
        onClick={() => onToggle(url)}
      >
        <span className="vk-parsing-video-choice__thumb">
          {isDirect ? (
            <video muted preload="metadata" playsInline aria-hidden>
              <source src={url} type={resolveVideoMimeType(url)} />
            </video>
          ) : (
            <VideoPoster />
          )}
        </span>
        <VideoMeta url={url} index={index} selected={checked} />
      </button>
      <a
        className="vk-parsing-video-choice__open"
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label="Открыть видео VK"
        title="Открыть видео VK"
      >
        <OpenNewWindow aria-hidden />
      </a>
    </div>
  );
}
