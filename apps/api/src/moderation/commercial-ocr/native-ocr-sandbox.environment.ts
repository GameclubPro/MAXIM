import { NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV } from './native-ocr-sandbox.protocol';

export const NATIVE_OCR_SANDBOX_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'LANG',
  'NODE_ENV',
  'HOME',
  'OMP_THREAD_LIMIT',
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  'PHOTO_DUPLICATE_MAX_BYTES',
  'COMMERCIAL_OCR_MAX_INPUT_PIXELS',
  'COMMERCIAL_OCR_MAX_OUTPUT_PIXELS',
  'COMMERCIAL_OCR_MAX_SIDE',
  'COMMERCIAL_OCR_TESSERACT_BINARY',
  'COMMERCIAL_OCR_TESSDATA_PREFIX',
  'COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS',
  'COMMERCIAL_OCR_TESSERACT_CONCURRENCY',
  'COMMERCIAL_OCR_TESSERACT_MAX_QUEUE',
  'COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS',
  'COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES',
  'COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES',
] as const);

export function restrictNativeOcrSandboxEnvironment(environment: NodeJS.ProcessEnv): void {
  const allowed = new Set<string>(NATIVE_OCR_SANDBOX_ENV_ALLOWLIST);
  for (const key of Object.keys(environment)) {
    if (!allowed.has(key)) {
      delete environment[key];
    }
  }
  environment.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  environment.HOME = '/home/node';
  environment.LANG = 'C.UTF-8';
  environment.NODE_ENV = 'production';
  assertNativeOcrSandboxEnvironmentRestricted(environment);
}

export function assertNativeOcrSandboxEnvironmentRestricted(environment: NodeJS.ProcessEnv): void {
  const allowed = new Set<string>(NATIVE_OCR_SANDBOX_ENV_ALLOWLIST);
  const unexpected = Object.keys(environment).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error('Native OCR sandbox process environment is not allowlisted');
  }
}
