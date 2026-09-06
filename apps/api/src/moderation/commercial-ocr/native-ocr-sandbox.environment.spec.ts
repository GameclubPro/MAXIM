import {
  assertNativeOcrSandboxEnvironmentRestricted,
  NATIVE_OCR_SANDBOX_ENV_ALLOWLIST,
  restrictNativeOcrSandboxEnvironment,
} from './native-ocr-sandbox.environment';

describe('native OCR sandbox environment', () => {
  it('removes application secrets before the native runtime is loaded', () => {
    const environment: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://secret',
      REDIS_URL: 'redis://secret',
      MAX_BOT_TOKEN: 'secret-token',
      PATH: '/untrusted/bin',
      LD_LIBRARY_PATH: '/untrusted/libraries',
      COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
    };

    restrictNativeOcrSandboxEnvironment(environment);

    expect(environment).not.toHaveProperty('DATABASE_URL');
    expect(environment).not.toHaveProperty('REDIS_URL');
    expect(environment).not.toHaveProperty('MAX_BOT_TOKEN');
    expect(environment).not.toHaveProperty('LD_LIBRARY_PATH');
    expect(environment).toMatchObject({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
    });
    const allowlist = new Set<string>(NATIVE_OCR_SANDBOX_ENV_ALLOWLIST);
    expect(Object.keys(environment).every((key) => allowlist.has(key))).toBe(true);
    expect(() => assertNativeOcrSandboxEnvironmentRestricted(environment)).not.toThrow();
  });

  it('refuses to attest a process that bypassed the allowlist entrypoint', () => {
    expect(() =>
      assertNativeOcrSandboxEnvironmentRestricted({ PATH: '/usr/bin', SECRET: 'present' }),
    ).toThrow('not allowlisted');
  });
});
