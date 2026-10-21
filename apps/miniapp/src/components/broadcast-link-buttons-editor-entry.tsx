import { Suspense, type ComponentProps } from 'react';
import type { BroadcastLinkButtonsEditor as EditorComponent } from './broadcast-link-buttons-editor';
import { Spinner } from './ui/spinner';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';

type BroadcastLinkButtonsEditorProps = ComponentProps<typeof EditorComponent>;

const LazyEditor = recoverableLazyNamedComponent<BroadcastLinkButtonsEditorProps>(
  () => import('./broadcast-link-buttons-editor'),
  'BroadcastLinkButtonsEditor',
);

export function BroadcastLinkButtonsEditor(props: BroadcastLinkButtonsEditorProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем кнопки сообщения" />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}
