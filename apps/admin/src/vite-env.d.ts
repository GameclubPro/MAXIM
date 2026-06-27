/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_ACCESS_CODE?: string;
  readonly VITE_PUBLIC_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
