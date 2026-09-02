import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { reloadAfterLazyPageLoadFailure } from './lazy-load-recovery';

type RecoverableLazyOptions<TProps> = {
  failureComponent?: ComponentType<TProps>;
  recover?: (exportName: string, cause: unknown) => boolean;
  waitAfterReload?: () => Promise<void>;
};

function LazyComponentLoadFailure() {
  return createElement(
    'button',
    {
      type: 'button',
      className: 'button button--danger',
      onClick: () => window.location.reload(),
    },
    'Обновить',
  );
}

export async function loadRecoverableNamedComponent<TProps>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
  options: RecoverableLazyOptions<TProps> = {},
): Promise<{ default: ComponentType<TProps> }> {
  try {
    const module = await loader();
    const component = module[exportName];
    if (!component) {
      throw new Error(`Lazy component export ${exportName} is missing.`);
    }
    return { default: component as ComponentType<TProps> };
  } catch (cause) {
    const recover = options.recover ?? reloadAfterLazyPageLoadFailure;
    let reloading = false;
    try {
      reloading = recover(exportName, cause);
    } catch {
      // The explicit reload action remains available when automatic recovery itself fails.
    }
    if (reloading) {
      await (
        options.waitAfterReload ??
        (() => new Promise<void>((resolve) => window.setTimeout(resolve, 4_000)))
      )();
    }
    return {
      default: options.failureComponent ?? (LazyComponentLoadFailure as ComponentType<TProps>),
    };
  }
}

export function recoverableLazyNamedComponent<TProps>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
): LazyExoticComponent<ComponentType<TProps>> {
  return lazy(() => loadRecoverableNamedComponent(loader, exportName));
}
