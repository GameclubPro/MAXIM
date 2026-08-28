import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { needsLegacyMultilineMarkdownNormalization } from './max-markdown';

type MarkdownNormalizer = (source: string) => string;
type MarkdownNormalizerModule = {
  normalizeLegacyMultilineMarkdown: MarkdownNormalizer;
};
type MarkdownNormalizerStatus = 'idle' | 'loading' | 'ready' | 'error';

export type NormalizedMarkdownSource = {
  status: 'ready' | 'loading' | 'error';
  value: string;
  retry: () => void;
};

export type MarkdownNormalizerResource = ReturnType<typeof createMarkdownNormalizerResource>;

export function createMarkdownNormalizerResource(
  loadModule: () => Promise<MarkdownNormalizerModule>,
) {
  let status: MarkdownNormalizerStatus = 'idle';
  let normalizer: MarkdownNormalizer | null = null;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const load = (): Promise<void> => {
    if (status === 'ready') return Promise.resolve();
    if (pending) return pending;

    status = 'loading';
    notify();
    pending = loadModule()
      .then((module) => {
        normalizer = module.normalizeLegacyMultilineMarkdown;
        status = 'ready';
      })
      .catch(() => {
        normalizer = null;
        status = 'error';
      })
      .finally(() => {
        pending = null;
        notify();
      });
    return pending;
  };

  return {
    getStatus: () => status,
    getNormalizer: () => normalizer,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    retry() {
      normalizer = null;
      status = 'idle';
      notify();
      return load();
    },
  };
}

export function resolveNormalizedMarkdownSource(
  resource: MarkdownNormalizerResource,
  source: string,
  enabled: boolean,
): Omit<NormalizedMarkdownSource, 'retry'> {
  if (!enabled || !needsLegacyMultilineMarkdownNormalization(source)) {
    return { status: 'ready', value: source };
  }

  const status = resource.getStatus();
  const normalize = resource.getNormalizer();
  if (status !== 'ready' || !normalize) {
    return { status: status === 'error' ? 'error' : 'loading', value: source };
  }

  try {
    return { status: 'ready', value: normalize(source) };
  } catch {
    return { status: 'error', value: source };
  }
}

const markdownNormalizerResource = createMarkdownNormalizerResource(() =>
  import('./max-markdown-multiline'),
);

export function useNormalizedMarkdownSource(
  source: string,
  enabled: boolean,
  preload = false,
): NormalizedMarkdownSource {
  const resourceStatus = useSyncExternalStore(
    markdownNormalizerResource.subscribe,
    markdownNormalizerResource.getStatus,
    markdownNormalizerResource.getStatus,
  );
  const result = resolveNormalizedMarkdownSource(markdownNormalizerResource, source, enabled);
  const shouldLoad = enabled && (preload || result.status === 'loading');

  useEffect(() => {
    if (shouldLoad && resourceStatus === 'idle') {
      void markdownNormalizerResource.load();
    }
  }, [resourceStatus, shouldLoad]);

  const retry = useCallback(() => {
    void markdownNormalizerResource.retry();
  }, []);

  return { ...result, retry };
}
