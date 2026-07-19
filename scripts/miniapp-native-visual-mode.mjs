export async function installNativeVisualModeInitScript(context) {
  await context.addInitScript(() => {
    window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
  });
}

export async function applyNativeVisualMode(page, profile) {
  const state = await page.evaluate(({ safeTop, safeBottom }) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-top', `${safeTop}px`);
    root.style.setProperty('--safe-bottom', `${safeBottom}px`);
    root.style.setProperty('--app-safe-top', `${safeTop}px`);
    root.style.setProperty('--app-safe-bottom', `${safeBottom}px`);
    root.style.setProperty('--app-viewport-height', `${window.innerHeight}px`);
    root.dataset.maxClient = 'native';

    const previewRoot = document.querySelector('.design-preview');
    const previewDock = document.querySelector('.design-preview__dock');
    const previewWrappers = [
      ['.design-preview', 'design-preview'],
      ['.design-preview__stage', 'design-preview__stage'],
      ['.design-preview__device', 'design-preview__device'],
      ['.design-preview__device-screen', 'design-preview__device-screen'],
    ];

    if (previewDock) {
      previewDock.hidden = true;
      previewDock.classList.remove('design-preview__dock');
    }
    for (const [selector, className] of previewWrappers) {
      const element = document.querySelector(selector);
      if (!element) {
        continue;
      }
      element.classList.remove(className);
      element.style.display = 'contents';
    }

    window.dispatchEvent(new Event('resize'));
    return {
      hadPreviewScaffold: Boolean(previewRoot),
      previewScaffoldDetached: !document.querySelector('.design-preview'),
    };
  }, profile);
  await page.waitForTimeout(120);
  return state;
}
