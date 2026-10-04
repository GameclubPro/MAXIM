import { write } from 'node:fs';

export const NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS = 25;
const MAX_NATIVE_SANDBOX_DIAGNOSTIC_BYTES = 512;

export function writeNativeSandboxLifecycleEvent(
  event: Readonly<Record<string, string | number>>,
): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > MAX_NATIVE_SANDBOX_DIAGNOSTIC_BYTES) {
    return Promise.reject(new Error('Native sandbox diagnostic exceeds its bound'));
  }
  // FLAG: Never block containment on a full Docker stderr pipe. The caller owns
  // the static, identifier-free event; no arbitrary errors or native content enter it.
  return new Promise<void>((resolve, reject) => {
    write(2, line, (error) => (error ? reject(error) : resolve()));
  });
}

export function createNativeSandboxRecycle<TEvent>(dependencies: {
  fatalExit: () => void;
  recordLifecycleEvent: (event: TEvent) => void | Promise<void>;
}): (event: TEvent) => void {
  let requested = false;
  return (event) => {
    if (requested) return;
    requested = true;
    let exited = false;
    const exitOnce = () => {
      if (exited) return;
      exited = true;
      clearTimeout(deadline);
      dependencies.fatalExit();
    };
    // FLAG: This referenced timer cannot be cancelled by sandbox shutdown or an
    // unresolved diagnostic. Poison/close admission before requesting the recycle.
    const deadline = setTimeout(exitOnce, NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS);
    const scheduleExit = () => {
      if (!exited) setImmediate(exitOnce);
    };
    void Promise.resolve()
      .then(() => dependencies.recordLifecycleEvent(event))
      .then(scheduleExit, scheduleExit);
  };
}
