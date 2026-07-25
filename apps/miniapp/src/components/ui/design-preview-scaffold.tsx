import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { cn } from '../../lib/cn';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHAT_ID,
  buildPreviewSearch,
  disablePreviewMode,
  persistPreviewDevice,
  stripPreviewSearch,
} from '../../lib/design-preview';
import {
  getPreviewDevicePreset,
  listPreviewDevices,
  type PreviewDevice,
} from '../../lib/preview-device';

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
    label: 'Статистика',
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

const previewDevices = listPreviewDevices();

function buildPreviewHref(pathname: string, device: PreviewDevice): string {
  return `${pathname}${buildPreviewSearch('', device)}`;
}

export function DesignPreviewScaffold({ children, initialDevice }: DesignPreviewScaffoldProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [device, setDevice] = useState<PreviewDevice>(initialDevice);
  const devicePreset = getPreviewDevicePreset(device);

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
          <p>Не 1:1 клиент MAX, но удобно править layout, safe-area, плотность и нативную рамку.</p>
        </div>

        <div className="design-preview__device-switch" role="tablist" aria-label="Устройство">
          {previewDevices.map((item) => {
            const preset = getPreviewDevicePreset(item);
            return (
              <button
                key={item}
                type="button"
                className={cn('design-preview__device-pill', device === item && 'is-active')}
                onClick={() => handleDeviceChange(item)}
              >
                {preset.label}
              </button>
            );
          })}
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
        <div
          className="design-preview__device"
          style={
            {
              '--design-preview-frame-width': `${devicePreset.frameWidth}px`,
              '--design-preview-screen-height': `${devicePreset.screenHeight}px`,
              '--design-preview-safe-top': `${devicePreset.safeTop}px`,
              '--design-preview-safe-bottom': `${devicePreset.safeBottom}px`,
            } as CSSProperties
          }
        >
          <div className="design-preview__device-screen">{children}</div>
        </div>
      </div>
    </div>
  );
}
