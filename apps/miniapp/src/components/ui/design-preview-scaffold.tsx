import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHAT_ID,
  buildPreviewSearch,
  disablePreviewMode,
  persistPreviewDevice,
  stripPreviewSearch,
  type PreviewDevice,
} from '../../lib/design-preview';

type DesignPreviewScaffoldProps = {
  children: ReactNode;
  initialDevice: PreviewDevice;
};

const previewLinks = [
  {
    label: 'Чаты',
    description: 'Список',
    path: '/',
  },
  {
    label: 'События',
    description: 'Чат',
    path: `/chat/${PREVIEW_CHAT_ID}/events`,
  },
  {
    label: 'Настройки',
    description: 'Чат',
    path: `/chat/${PREVIEW_CHAT_ID}/settings`,
  },
  {
    label: 'Канал',
    description: 'Настройки',
    path: `/channel/${PREVIEW_CHANNEL_ID}/settings`,
  },
  {
    label: 'Статы',
    description: 'Канал',
    path: `/channel/${PREVIEW_CHANNEL_ID}/stats`,
  },
] as const;

function buildPreviewHref(pathname: string, device: PreviewDevice): string {
  return `${pathname}${buildPreviewSearch('', device)}`;
}

export function DesignPreviewScaffold({
  children,
  initialDevice,
}: DesignPreviewScaffoldProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [device, setDevice] = useState<PreviewDevice>(initialDevice);

  useEffect(() => {
    setDevice(initialDevice);
  }, [initialDevice]);

  useEffect(() => {
    persistPreviewDevice(device);
  }, [device]);

  function handleDeviceChange(nextDevice: PreviewDevice) {
    setDevice(nextDevice);
    navigate(
      {
        pathname: location.pathname,
        search: buildPreviewSearch(location.search, nextDevice),
      },
      { replace: true },
    );
  }

  function handleExitPreview() {
    disablePreviewMode();
    navigate(
      {
        pathname: location.pathname,
        search: stripPreviewSearch(location.search),
      },
      { replace: true },
    );
  }

  return (
    <div className="design-preview">
      <aside className="design-preview__dock glass-card glass-card--sm">
        <div className="design-preview__dock-head">
          <span className="design-preview__eyebrow">Design preview</span>
          <h2>MAX-like mobile frame</h2>
          <p>Не 1:1 клиент MAX, но удобно править layout, safe-area и шапки.</p>
        </div>

        <div className="design-preview__device-switch" role="tablist" aria-label="Устройство">
          <button
            type="button"
            className={cn('design-preview__device-pill', device === 'android' && 'is-active')}
            onClick={() => handleDeviceChange('android')}
          >
            Android
          </button>
          <button
            type="button"
            className={cn('design-preview__device-pill', device === 'iphone' && 'is-active')}
            onClick={() => handleDeviceChange('iphone')}
          >
            iPhone
          </button>
        </div>

        <nav className="design-preview__nav" aria-label="Экраны preview">
          {previewLinks.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={buildPreviewHref(item.path, device)}
                className={cn('design-preview__nav-link', isActive && 'is-active')}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          className="button button--ghost design-preview__exit"
          onClick={handleExitPreview}
        >
          Выйти из preview
        </button>
      </aside>

      <div className="design-preview__stage">
        <div className={cn('design-preview__device', `design-preview__device--${device}`)}>
          <div className="design-preview__device-chrome" aria-hidden>
            <span className="design-preview__device-speaker" />
            <span className="design-preview__device-camera" />
          </div>
          <div className="design-preview__device-screen">{children}</div>
        </div>
      </div>
    </div>
  );
}
