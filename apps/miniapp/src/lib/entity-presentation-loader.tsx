import { useEffect } from 'react';
import type { ManagedEntityPresentation } from '@maxim/contracts';
import { useEntityPresentation } from './use-entity-presentation';

export default function EntityPresentationLoader(
  props: Parameters<typeof useEntityPresentation>[0] & {
    onChange: (state: { scope: string; items: Record<string, ManagedEntityPresentation> }) => void;
  },
) {
  const items = useEntityPresentation(props);
  const { scope, entityType, onChange } = props;
  useEffect(() => {
    onChange({ scope: `${scope}:${entityType}`, items });
  }, [items, scope, entityType, onChange]);
  return null;
}
