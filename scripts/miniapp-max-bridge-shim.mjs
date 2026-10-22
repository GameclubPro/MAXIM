const DEFAULT_USER_ID = 900719925;
const DEFAULT_USER = {
  id: DEFAULT_USER_ID,
  first_name: 'Майор',
  last_name: 'Максимов',
  username: 'major_maximov_preview',
  language_code: 'ru',
  is_premium: false,
};

function normalizePlatform(profile) {
  return profile?.platform === 'ios' ? 'ios' : 'android';
}

function createUnsignedInitData(user, startParam) {
  const params = new URLSearchParams();
  params.set('query_id', 'preview-query-id');
  params.set('user', JSON.stringify(user));
  params.set('auth_date', '1781452800');
  if (startParam) {
    params.set('start_param', startParam);
  }
  params.set('hash', 'preview-unsigned-hash');
  return params.toString();
}

export async function installMaxBridgeShimInitScript(context, profile, options = {}) {
  await context.addInitScript(
    ({ profile: bridgeProfile, options: bridgeOptions }) => {
      const platform =
        bridgeOptions.platform || (bridgeProfile?.platform === 'ios' ? 'ios' : 'android');
      const colorScheme =
        bridgeOptions.colorScheme ||
        (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const themeParams =
        colorScheme === 'dark'
          ? {
              bg_color: '#10171b',
              secondary_bg_color: '#121c22',
              text_color: '#f2f6f8',
              hint_color: '#becfd8',
            }
          : {
              bg_color: '#f4f8f8',
              secondary_bg_color: '#ffffff',
              text_color: '#172535',
              hint_color: '#445462',
            };
      const user = {
        first_name: 'Майор',
        last_name: 'Максимов',
        username: 'major_maximov_preview',
        language_code: 'ru',
        is_premium: false,
        ...(bridgeOptions.user || {}),
        id: bridgeOptions.userId || bridgeOptions.user?.id || 900719925,
      };
      const events = [];
      const backButtonHandlers = new Set();

      const record = (type, payload = {}) => {
        events.push({
          type,
          payload,
          at: Date.now(),
        });
        if (events.length > 500) {
          events.splice(0, events.length - 500);
        }
      };

      const readStartParamFromUrl = () => {
        const names = ['WebAppStartParam', 'startapp', 'startApp', 'start_param', 'startParam'];
        const sources = [window.location.search, window.location.hash];

        for (const source of sources) {
          const normalized = String(source || '').replace(/^[?#]/u, '');
          if (!normalized) {
            continue;
          }

          const queryIndex = normalized.indexOf('?');
          const candidates =
            queryIndex >= 0 ? [normalized, normalized.slice(queryIndex + 1)] : [normalized];
          for (const candidate of candidates) {
            const params = new URLSearchParams(candidate);
            for (const name of names) {
              const value = params.get(name);
              if (value?.trim()) {
                return value.trim();
              }
            }
          }
        }

        return '';
      };

      const startParam = bridgeOptions.startParam || readStartParamFromUrl();
      const params = new URLSearchParams();
      params.set('query_id', 'preview-query-id');
      params.set('user', JSON.stringify(user));
      params.set('auth_date', '1781452800');
      if (startParam) {
        params.set('start_param', startParam);
      }
      params.set('hash', 'preview-unsigned-hash');
      const initData = bridgeOptions.initData || params.toString();

      const createStorageArea = (areaName) => {
        const values = new Map();

        return {
          async getItem(key) {
            const normalizedKey = String(key);
            const value = values.has(normalizedKey) ? values.get(normalizedKey) : null;
            record(`${areaName}.getItem`, { key: normalizedKey, hit: value !== null });
            return {
              key: normalizedKey,
              value,
            };
          },
          async setItem(key, value) {
            const normalizedKey = String(key);
            const normalizedValue = String(value);
            values.set(normalizedKey, normalizedValue);
            record(`${areaName}.setItem`, { key: normalizedKey, length: normalizedValue.length });
            return { status: 'ok' };
          },
          async removeItem(key) {
            const normalizedKey = String(key);
            values.delete(normalizedKey);
            record(`${areaName}.removeItem`, { key: normalizedKey });
            return { status: 'ok' };
          },
          async clear() {
            values.clear();
            record(`${areaName}.clear`, {});
            return { status: 'ok' };
          },
        };
      };

      const bridge = {
        version: bridgeOptions.version || '26.6.0-preview',
        platform,
        colorScheme,
        color_scheme: colorScheme,
        theme: colorScheme,
        themeParams,
        theme_params: themeParams,
        initData,
        init_data: initData,
        initDataUnsafe: {
          user,
          start_param: startParam,
        },
        init_data_unsafe: {
          user,
          start_param: startParam,
        },
        startParam,
        start_param: startParam,
        isClosingConfirmationEnabled: false,
        ready() {
          record('ready');
        },
        close() {
          record('close');
          window.__MAXIM_VISUAL_BRIDGE_CLOSED__ = true;
        },
        openLink(url) {
          record('openLink', { url: String(url) });
        },
        openMaxLink(url) {
          record('openMaxLink', { url: String(url) });
        },
        async downloadFile(url, fileName) {
          record('downloadFile', { url: String(url), fileName: String(fileName || '') });
          return { status: 'ok' };
        },
        async shareContent(payload) {
          record('shareContent', payload || {});
          return { status: 'ok' };
        },
        async shareMaxContent(payload) {
          record('shareMaxContent', payload || {});
          return { status: 'ok' };
        },
        enableClosingConfirmation() {
          bridge.isClosingConfirmationEnabled = true;
          record('enableClosingConfirmation');
        },
        disableClosingConfirmation() {
          bridge.isClosingConfirmationEnabled = false;
          record('disableClosingConfirmation');
        },
        BackButton: {
          isVisible: false,
          show() {
            bridge.BackButton.isVisible = true;
            record('BackButton.show');
          },
          hide() {
            bridge.BackButton.isVisible = false;
            record('BackButton.hide');
          },
          onClick(callback) {
            if (typeof callback === 'function') {
              backButtonHandlers.add(callback);
            }
            record('BackButton.onClick', { handlers: backButtonHandlers.size });
          },
          offClick(callback) {
            backButtonHandlers.delete(callback);
            record('BackButton.offClick', { handlers: backButtonHandlers.size });
          },
        },
        HapticFeedback: {
          impactOccurred(style) {
            record('HapticFeedback.impactOccurred', { style: style || 'light' });
          },
          notificationOccurred(type) {
            record('HapticFeedback.notificationOccurred', { type: type || 'success' });
          },
          selectionChanged() {
            record('HapticFeedback.selectionChanged');
          },
        },
        DeviceStorage: createStorageArea('DeviceStorage'),
        SecureStorage: createStorageArea('SecureStorage'),
      };

      window.__MAXIM_VISUAL_BRIDGE_EVENTS__ = events;
      window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__ = () => {
        record('BackButton.press', { handlers: backButtonHandlers.size });
        for (const callback of Array.from(backButtonHandlers)) {
          callback();
        }
      };
      window.__MAXIM_VISUAL_BRIDGE__ = bridge;
      window.WebApp = bridge;
      window.MAX = {
        ...(window.MAX || {}),
        WebApp: bridge,
      };
    },
    {
      profile: {
        platform: normalizePlatform(profile),
      },
      options: {
        initData: options.initData || '',
        colorScheme: options.colorScheme || '',
        platform: options.platform || normalizePlatform(profile),
        startParam: options.startParam || '',
        user: options.user || DEFAULT_USER,
        userId: options.userId || DEFAULT_USER_ID,
        version: options.version || '26.6.0-preview',
      },
    },
  );
}

export async function assertMaxBridgeShim(page) {
  const state = await page.evaluate(() => {
    const bridge = window.MAX?.WebApp ?? window.WebApp;
    return {
      hasBridge: Boolean(bridge),
      platform: bridge?.platform ?? null,
      hasInitData: Boolean(bridge?.initData || bridge?.init_data),
      hasUser: Boolean(bridge?.initDataUnsafe?.user || bridge?.init_data_unsafe?.user),
      hasBackButton: Boolean(bridge?.BackButton?.show && bridge?.BackButton?.onClick),
      hasStorage: Boolean(bridge?.DeviceStorage?.getItem && bridge?.SecureStorage?.setItem),
    };
  });

  if (
    !state.hasBridge ||
    !state.platform ||
    !state.hasInitData ||
    !state.hasUser ||
    !state.hasBackButton ||
    !state.hasStorage
  ) {
    throw new Error(`MAX Bridge visual shim is incomplete: ${JSON.stringify(state)}`);
  }
}

export function createPreviewInitData(options = {}) {
  const user = {
    ...DEFAULT_USER,
    ...(options.user || {}),
  };
  return createUnsignedInitData(user, options.startParam || '');
}
