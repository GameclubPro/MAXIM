import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { contractsSourceAliases } from '../../scripts/vite-contracts-source.mjs';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = normalizeBasePath(env.MINIAPP_BASE_PATH || env.VITE_PUBLIC_BASE_PATH || '/app/');
  const apiFallbacksEnabled = Boolean(env.VITE_API_FALLBACK_BASES?.trim());
  const routerMode = env.VITE_ROUTER_MODE?.trim() === 'hash' ? 'hash' : 'browser';

  return {
    plugins: [
      react(),
      {
        name: 'maxim-visual-server-identity',
        apply: 'serve',
        configureServer(server) {
          const identity = process.env.MAXIM_VISUAL_SERVER_ID;
          if (identity) {
            server.middlewares.use((_request, response, next) => {
              response.setHeader('X-Maxim-Visual-Server', identity);
              next();
            });
          }
        },
      },
    ],
    resolve: {
      alias: contractsSourceAliases(fileURLToPath(new URL('../../', import.meta.url)), command),
    },
    define: {
      __MAXIM_API_FALLBACKS_ENABLED__: JSON.stringify(apiFallbacksEnabled),
      __MAXIM_ROUTER_MODE__: JSON.stringify(routerMode),
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    base,
    build: {
      manifest: true,
    },
  };
});

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '/app/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}
