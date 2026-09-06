import { restrictNativeOcrSandboxEnvironment } from './native-ocr-sandbox.environment';

export {
  NATIVE_OCR_SANDBOX_ENV_ALLOWLIST,
  restrictNativeOcrSandboxEnvironment,
} from './native-ocr-sandbox.environment';

async function main(argv: readonly string[]): Promise<void> {
  restrictNativeOcrSandboxEnvironment(process.env);
  if (argv.length === 1 && argv[0] === '--probe') {
    const { NativeOcrSandboxClient } = await import('./native-ocr-sandbox.client');
    const client = new NativeOcrSandboxClient({
      get: (propertyPath: string): unknown => process.env[propertyPath],
    });
    try {
      await client.probe();
      process.stdout.write('Native OCR sandbox probe passed.\n');
    } finally {
      client.close();
    }
    return;
  }
  if (argv.length > 0) {
    throw new Error('Usage: native-ocr-sandbox.entrypoint.js [--probe]');
  }

  const { startNativeOcrSandboxServer } = await import('./native-ocr-sandbox.server');
  const server = await startNativeOcrSandboxServer(process.env);
  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server
      .close()
      .then(() => process.exit(exitCode))
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Native OCR sandbox failed'}\n`,
    );
    process.exitCode = 1;
  });
}
