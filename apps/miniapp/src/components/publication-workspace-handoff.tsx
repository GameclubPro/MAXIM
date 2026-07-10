import { NavArrowRight } from 'iconoir-react';
import { Link } from 'react-router-dom';
import type { ManagedEntityType } from '@maxim/contracts';
import './publication-workspace-handoff.css';

type PublicationWorkspaceHandoffProps = {
  entityType: ManagedEntityType;
  entityId: string;
};

export function PublicationWorkspaceHandoff({
  entityType,
  entityId,
}: PublicationWorkspaceHandoffProps) {
  return (
    <Link
      className="publication-workspace-handoff"
      to={`/publications?compose=1&entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`}
    >
      <span>Открыть публикации</span>
      <NavArrowRight aria-hidden />
    </Link>
  );
}
