import type { ChildProcess } from 'node:child_process';

import {
  signalNativeProcessGroup,
  verifyNativeProcessGroupTeardown,
  type NativeProcessGroupDependencies,
} from './native-process-group';

describe('native OCR process-group containment', () => {
  it('signals the negative PGID and verifies the whole group disappeared', async () => {
    let exists = true;
    let now = 0;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const dependencies: NativeProcessGroupDependencies = {
      platform: 'linux',
      signal: (processId, signal) => {
        signals.push([processId, signal]);
        if (signal === 0 && !exists) {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        if (signal === 'SIGKILL') exists = false;
      },
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs;
      },
    };
    const child = { pid: 321, kill: jest.fn() } as unknown as ChildProcess;

    expect(
      signalNativeProcessGroup(child, 'SIGTERM', {
        requireIsolatedGroup: true,
        dependencies,
      }),
    ).toBe(true);
    expect(signals[0]).toEqual([-321, 'SIGTERM']);
    expect(
      await verifyNativeProcessGroupTeardown(child, {
        graceMs: 250,
        requireIsolatedGroup: true,
        dependencies,
      }),
    ).toBe(true);
    expect(signals).toContainEqual([-321, 'SIGKILL']);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('fails closed when a required isolated process group cannot be identified', async () => {
    const child = { pid: undefined, kill: jest.fn() } as unknown as ChildProcess;
    expect(signalNativeProcessGroup(child, 'SIGKILL', { requireIsolatedGroup: true })).toBe(false);
    await expect(
      verifyNativeProcessGroupTeardown(child, {
        graceMs: 250,
        requireIsolatedGroup: true,
      }),
    ).resolves.toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not attest a process group that remains observable after SIGKILL', async () => {
    let now = 0;
    const dependencies: NativeProcessGroupDependencies = {
      platform: 'linux',
      signal: jest.fn(),
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs;
      },
    };
    const child = { pid: 654, kill: jest.fn() } as unknown as ChildProcess;

    await expect(
      verifyNativeProcessGroupTeardown(child, {
        graceMs: 25,
        requireIsolatedGroup: true,
        dependencies,
      }),
    ).resolves.toBe(false);
    expect(dependencies.signal).toHaveBeenCalledWith(-654, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });
});
