import { InfoCircle } from 'iconoir-react';
import { useId, useState, type ReactNode } from 'react';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';

export function VkInfoButton({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="vk-info-button"
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <InfoCircle aria-hidden />
      </button>
      <SettingsDrilldownPanel
        id={`vk-info-${id}`}
        open={open}
        title={title}
        overlayClassName="vk-dialog-overlay"
        className="vk-parsing-surface vk-workspace-dialog vk-info-dialog"
        onClose={() => setOpen(false)}
      >
        <div className="vk-info-copy">{children}</div>
      </SettingsDrilldownPanel>
    </>
  );
}
