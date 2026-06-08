import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = normalizeBasePath(env.MINIAPP_BASE_PATH || env.VITE_PUBLIC_BASE_PATH || '/app/');
  const apiFallbacksEnabled = Boolean(env.VITE_API_FALLBACK_BASES?.trim());

  return {
    plugins: [react()],
    define: {
      __MAXIM_API_FALLBACKS_ENABLED__: JSON.stringify(apiFallbacksEnabled),
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
