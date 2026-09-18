import type { ReactNode } from 'react';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import '../../styles/vk-parsing-workspace.css';

export function VkWorkspaceShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <SettingsDrilldownPanel
      id="publisher-vk-workspace"
      open
      title="Посты из VK"
      summary={title}
      variant="screen"
      overlayClassName="vk-dialog-overlay vk-workspace-overlay"
      className="vk-parsing-surface vk-workspace-dialog vk-workspace-screen"
      onClose={onClose}
    >
      <div id="publisher-vk-workspace" className="publisher-entity-vk-module__workspace">
        {children}
      </div>
    </SettingsDrilldownPanel>
  );
}
