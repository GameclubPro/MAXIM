import { readFile } from 'node:fs/promises';
import { devices } from 'playwright';

// Host chrome is a configurable approximation, not a recording of a MAX release.
const HOST_METRICS = {
  android: { statusBarHeight: 24, headerHeight: 56, systemBottom: 24, safeBottom: 0 },
  iphone: { statusBarHeight: 59, headerHeight: 44, systemBottom: 0, safeBottom: 34 },
  'iphone-se': { statusBarHeight: 20, headerHeight: 44, systemBottom: 0, safeBottom: 0 },
};
const keyboardSessions = new WeakMap();

export function captureBrowserLaunchOptions(browserName, baseUrl, headless = true) {
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname);
  // Linux WebKit's system proxy resolver can fail even on loopback in WSL.
  return browserName === 'webkit' && local && process.platform === 'linux'
    ? { headless, env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' } }
    : { headless };
}

export async function readPhoneMetrics(filePath) {
  if (!filePath) return {};
  const metrics = JSON.parse(await readFile(filePath, 'utf8'));
  if (!metrics || Array.isArray(metrics) || typeof metrics !== 'object') {
    throw new Error('Phone metrics must be an object keyed by android, iphone or iphone-se.');
  }
  for (const key of Object.keys(metrics)) {
    if (!Object.hasOwn(HOST_METRICS, key)) throw new Error(`Unknown phone metrics device: ${key}`);
  }
  return metrics;
}

export function resolveCaptureDevice(
  profile,
  { target = 'smartphone', engine, metrics = {} } = {},
) {
  const device = devices[profile.viewportName];
  if (!device) throw new Error(`Unknown Playwright device: ${profile.viewportName}`);
  const { defaultBrowserType, ...contextOptions } = device;
  const browserName =
    engine && engine !== 'auto'
      ? engine
      : target === 'smartphone'
        ? defaultBrowserType
        : 'chromium';
  if (!['chromium', 'webkit'].includes(browserName)) {
    throw new Error('Browser engine must be auto, chromium or webkit.');
  }
  if (target !== 'smartphone') return { browserName, contextOptions, profile, phone: null };

  const screen = device.screen ?? device.viewport;
  const defaults = {
    width: screen.width,
    height: screen.height,
    ...HOST_METRICS[profile.queryDevice],
  };
  const override = metrics[profile.queryDevice] ?? {};
  if (!override || Array.isArray(override) || typeof override !== 'object') {
    throw new Error(`Invalid phone metrics for ${profile.queryDevice}`);
  }
  for (const [key, value] of Object.entries(override)) {
    if (!Object.hasOwn(defaults, key) || !Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid phone metric ${key}: ${value}`);
    }
  }
  const phone = { ...defaults, ...override };
  const viewport = {
    width: phone.width,
    height: phone.height - phone.statusBarHeight - phone.headerHeight - phone.systemBottom,
  };
  if (viewport.width < 240 || viewport.height < 240 || phone.safeBottom >= viewport.height) {
    throw new Error('Phone metrics leave an invalid WebView viewport.');
  }
  return {
    browserName,
    contextOptions: {
      ...contextOptions,
      screen: { width: phone.width, height: phone.height },
      viewport,
    },
    profile: { ...profile, safeTop: 0, safeBottom: phone.safeBottom },
    phone: { ...phone, viewport, calibrated: Object.keys(override).length > 0 },
  };
}

export async function readCaptureGeometry(page) {
  return page.evaluate(() => ({
    layout: { width: innerWidth, height: innerHeight },
    visual: {
      width: visualViewport?.width ?? innerWidth,
      height: visualViewport?.height ?? innerHeight,
      offsetTop: visualViewport?.offsetTop ?? 0,
      scale: visualViewport?.scale ?? 1,
    },
    screen: { width: screen.width, height: screen.height },
    deviceScaleFactor: devicePixelRatio,
    touchPoints: navigator.maxTouchPoints,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    touchEvents: 'ontouchstart' in window,
    userAgent: navigator.userAgent,
    safeTop: getComputedStyle(document.documentElement).getPropertyValue('--app-safe-top').trim(),
    safeBottom: getComputedStyle(document.documentElement)
      .getPropertyValue('--app-safe-bottom')
      .trim(),
  }));
}

export async function setPhoneKeyboard(page, { height = 320, mode = 'visual', open = true } = {}) {
  if (!['visual', 'resize'].includes(mode))
    throw new Error('Keyboard mode must be visual or resize.');
  const originalState = await page.evaluate(
    () =>
      window.__MAXIM_PHONE_KEYBOARD__ ?? {
        original: innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
        scale: devicePixelRatio,
      },
  );
  const original = originalState.original;
  const visibleHeight = open ? Math.max(180, original - height) : original;
  await page.evaluate(
    (state) => {
      window.__MAXIM_PHONE_KEYBOARD__ = state;
    },
    { ...originalState, mode },
  );
  if (mode === 'resize') {
    await page.setViewportSize({ width: page.viewportSize().width, height: visibleHeight });
    if (page.context().browser().browserType().name() === 'chromium') {
      let session = keyboardSessions.get(page);
      if (!session) {
        session = await page.context().newCDPSession(page);
        keyboardSessions.set(page, session);
      }
      // adjustResize changes the WebView, not the physical display or its orientation.
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: page.viewportSize().width,
        height: visibleHeight,
        screenWidth: originalState.screenWidth,
        screenHeight: originalState.screenHeight,
        deviceScaleFactor: originalState.scale,
        mobile: true,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
      });
    }
  } else {
    await page.evaluate(
      ({ visibleHeight, open }) => {
        if (open) {
          Object.defineProperty(visualViewport, 'height', {
            configurable: true,
            get: () => visibleHeight,
          });
        } else {
          delete visualViewport.height;
        }
        visualViewport.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
      },
      { visibleHeight, open },
    );
  }
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return {
    mode,
    originalHeight: original,
    viewportHeight: visibleHeight,
    coveredHeight: original - visibleHeight,
  };
}

export async function settleVisualFrame(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Finish finite transitions before measuring, just as screenshot(animations: disabled) does.
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try {
          animation.finish();
        } catch {
          /* An animation may have been cancelled by React. */
        }
      }
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function capturePhoneScreenshot(
  browser,
  page,
  capture,
  path,
  { theme = 'light', title = 'Майор Максимов', keyboard = null, imageBuffer } = {},
) {
  const { phone, contextOptions } = capture;
  const image = imageBuffer ?? (await page.screenshot({ animations: 'disabled', scale: 'device' }));
  const context = await browser.newContext({
    viewport: { width: phone.width, height: phone.height },
    deviceScaleFactor: contextOptions.deviceScaleFactor,
  });
  try {
    const canvas = await context.newPage();
    const dark = theme === 'dark';
    const visibleHeight = keyboard?.viewportHeight ?? phone.viewport.height;
    await canvas.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;color:${dark ? '#f0f2f4' : '#202831'};background:${dark ? '#1b1f23' : '#fff'};font:14px Arial,sans-serif}
      .status{height:${phone.statusBarHeight}px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-weight:bold}
      .signals{display:flex;align-items:center;gap:5px}.signal{display:flex;gap:2px;align-items:flex-end;height:12px}.signal i{width:3px;background:currentColor}
      .battery{width:22px;height:11px;border:1px solid currentColor;border-radius:3px;padding:1px}.battery:after{content:'';display:block;width:85%;height:100%;background:currentColor;border-radius:1px}
      .header{height:${phone.headerHeight}px;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;text-align:center;border-bottom:1px solid ${dark ? '#353e47' : '#dce1e7'}}
      .title{font-size:15px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.close{font-size:24px}.menu{font-weight:bold;font-size:20px}
      .webview{height:${visibleHeight}px;overflow:hidden}.webview img{display:block;width:${phone.width}px;height:auto}
      .keyboard{height:${keyboard?.coveredHeight ?? 0}px;background:${dark ? '#303236' : '#d5d8de'};padding:12px 4px;display:${keyboard ? 'grid' : 'none'};grid-template-rows:repeat(4,1fr);gap:8px}
      .keys{display:flex;justify-content:center;gap:4px;min-height:0}.key{flex:1;max-width:42px;display:grid;place-items:center;background:${dark ? '#56585c' : '#fff'};border-radius:5px;box-shadow:0 1px 1px #777;font-size:17px}.space{max-width:200px;flex:5}
      .system{height:${phone.systemBottom}px}.home{position:absolute;bottom:7px;left:35%;width:30%;height:4px;border-radius:4px;background:currentColor;display:${phone.safeBottom || phone.systemBottom ? 'block' : 'none'}}
    </style></head><body><div class="status"><span>9:41</span><span class="signals"><span class="signal"><i style="height:4px"></i><i style="height:7px"></i><i style="height:10px"></i><i style="height:12px"></i></span><span>5G</span><span class="battery"></span></span></div>
    <div class="header"><span class="close">×</span><span class="title"></span><span class="menu">···</span></div>
    <div class="webview"><img alt="Mini app capture"></div><div class="keyboard"></div><div class="system"></div><div class="home"></div></body></html>`);
    await canvas.locator('.title').evaluate((node, text) => {
      node.textContent = text;
    }, title);
    await canvas.locator('.webview img').evaluate(
      async (node, source) => {
        node.src = source;
        await node.decode();
      },
      `data:image/png;base64,${image.toString('base64')}`,
    );
    if (keyboard)
      await canvas.locator('.keyboard').evaluate((node) => {
        for (const row of [
          'й ц у к е н г ш щ з х',
          'ф ы в а п р о л д ж э',
          'я ч с м и т ь б ю',
          '123 пробел ↵',
        ]) {
          const line = document.createElement('div');
          line.className = 'keys';
          for (const text of row.split(' ')) {
            const key = document.createElement('span');
            key.className = text === 'пробел' ? 'key space' : 'key';
            key.textContent = text;
            line.append(key);
          }
          node.append(line);
        }
      });
    await canvas.screenshot({ path, scale: 'device' });
  } finally {
    await context.close();
  }
}
