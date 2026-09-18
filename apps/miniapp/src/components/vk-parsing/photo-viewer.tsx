import { NavArrowLeft, NavArrowRight, WarningCircle } from 'iconoir-react';
import { useRef, useState } from 'react';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';

export function VkPhotoViewer({
  urls,
  initialIndex,
  onClose,
}: {
  urls: string[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const url = urls[index]!;
  function move(direction: number) {
    setIndex((current) => (current + direction + urls.length) % urls.length);
  }
  return (
    <SettingsDrilldownPanel
      id="vk-photo-viewer"
      open
      title="Фото из поста"
      variant="screen"
      overlayClassName="vk-dialog-overlay"
      className="vk-parsing-surface vk-workspace-dialog vk-photo-dialog"
      onClose={onClose}
      initialFocusRef={viewerRef}
    >
      <div
        ref={viewerRef}
        tabIndex={-1}
        className="vk-photo-viewer"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            move(event.key === 'ArrowRight' ? 1 : -1);
          }
        }}
      >
        <div className="vk-photo-viewer__image">
          {failedUrls.includes(url) ? (
            <div role="status">
              <WarningCircle aria-hidden />
              <p>Фото пока недоступно</p>
            </div>
          ) : (
            <img
              src={url}
              alt={`Фото ${index + 1} из ${urls.length}`}
              onError={() => setFailedUrls((current) => [...current, url])}
            />
          )}
        </div>
        <div className="vk-photo-viewer__navigation">
          <button
            type="button"
            className="vk-parsing-icon-button"
            aria-label="Предыдущее фото"
            title="Предыдущее фото"
            disabled={urls.length < 2}
            onClick={() => move(-1)}
          >
            <NavArrowLeft aria-hidden />
          </button>
          <span role="status">
            {index + 1} из {urls.length}
          </span>
          <button
            type="button"
            className="vk-parsing-icon-button"
            aria-label="Следующее фото"
            title="Следующее фото"
            disabled={urls.length < 2}
            onClick={() => move(1)}
          >
            <NavArrowRight aria-hidden />
          </button>
        </div>
      </div>
    </SettingsDrilldownPanel>
  );
}
