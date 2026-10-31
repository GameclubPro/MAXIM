import { spawn } from 'node:child_process';

export function runVerificationCommand({ executable, args, cwd }, log = null) {
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, MAXIM_AGENT_VERIFY: '1' },
    stdio: log ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  if (log) {
    child.stdout.on('data', (chunk) => log(chunk));
    child.stderr.on('data', (chunk) => log(chunk));
  }
  return new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      const error = new Error(
        `${executable} ${args.join(' ')} failed${signal ? ` with ${signal}` : ` with code ${code}`}.`,
      );
      error.exitCode = code;
      error.signal = signal;
      reject(error);
    });
  });
}
