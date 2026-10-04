import { NativePhotoSandboxClient } from './native-photo-sandbox.client';
import { PHOTO_NATIVE_SOCKET_PATH } from './native-photo-sandbox.protocol';
import { startNativePhotoSandbox } from './native-photo-sandbox.server';

async function main() {
  if (process.argv.includes('--smoke')) {
    await new NativePhotoSandboxClient(
      process.env.PHOTO_NATIVE_SANDBOX_SOCKET_PATH ?? PHOTO_NATIVE_SOCKET_PATH,
    ).smoke();
    return;
  }
  if (process.argv.includes('--probe')) {
    await new NativePhotoSandboxClient(
      process.env.PHOTO_NATIVE_SANDBOX_SOCKET_PATH ?? PHOTO_NATIVE_SOCKET_PATH,
    ).probe();
    return;
  }
  const server = await startNativePhotoSandbox();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(70),
    );
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
void main().catch(() => {
  process.exitCode = 1;
});
