export async function installNativeVisualModeInitScript(context) {
  await context.addInitScript(() => {
    window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
  });
}

export async function applyNativeVisualMode(page, profile) {
  await page.addStyleTag({
    content: `
      .design-preview {
        display: block !important;
        min-height: 100dvh !important;
        padding: 0 !important;
        background: transparent !important;
      }

      .design-preview__dock {
        display: none !important;
      }

      .design-preview__stage,
      .design-preview__device,
      .design-preview__device-screen {
        display: block !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        min-height: 100dvh !important;
        height: auto !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: visible !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }

      .design-preview .app-shell {
        min-height: var(--app-viewport-height) !important;
        height: auto !important;
        width: min(100%, var(--app-shell-max-width)) !important;
        max-width: var(--app-shell-max-width) !important;
        padding: calc(var(--app-safe-top) + 10px) var(--app-page-gutter) 0 !important;
        padding-bottom: calc(
          var(--bottom-nav-height, var(--app-bottom-nav-height)) + var(--app-safe-bottom) +
            var(--bottom-nav-offset, 8px) + 12px
        ) !important;
        overflow: visible !important;
      }

      .design-preview .app-shell--immersive {
        width: 100% !important;
        max-width: none !important;
        height: calc(
          var(--app-viewport-height) + var(--immersive-top-bleed, 0px) +
            var(--immersive-bottom-bleed, 0px)
        ) !important;
        min-height: calc(
          var(--app-viewport-height) + var(--immersive-top-bleed, 0px) +
            var(--immersive-bottom-bleed, 0px)
        ) !important;
        padding: 0 !important;
        overflow: hidden !important;
      }

      .design-preview .bottom-nav {
        position: fixed !important;
        left: 50% !important;
        right: auto !important;
        bottom: calc(var(--app-safe-bottom) + var(--bottom-nav-offset, 8px)) !important;
        width: min(calc(100% - 24px), var(--app-shell-max-width)) !important;
      }

      .design-preview .compact-page-header {
        max-width: none !important;
      }
    `,
  });

  await page.evaluate(({ safeTop, safeBottom }) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-top', `${safeTop}px`);
    root.style.setProperty('--safe-bottom', `${safeBottom}px`);
    root.style.setProperty('--app-safe-top', `${safeTop}px`);
    root.style.setProperty('--app-safe-bottom', `${safeBottom}px`);
    root.style.setProperty('--app-viewport-height', `${window.innerHeight}px`);
    root.dataset.maxClient = 'native';
    window.dispatchEvent(new Event('resize'));
  }, profile);
  await page.waitForTimeout(120);
}
