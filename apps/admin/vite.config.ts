import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = normalizeBasePath(env.ADMIN_BASE_PATH || env.VITE_PUBLIC_BASE_PATH || '/admin/');

  return {
    plugins: [react()],
    base,
    server: {
      port: 3002,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: env.VITE_ADMIN_API_DEV_TARGET || 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
    build: {
      manifest: true,
    },
  };
});

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '/admin/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}
