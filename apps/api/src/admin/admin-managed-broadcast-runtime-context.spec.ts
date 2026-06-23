import { createAdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';

describe('AdminManagedBroadcastRuntimeContext', () => {
  it('reads and writes legacy target properties through a typed bridge', () => {
    const target = { value: 1 } as { value: number; extra?: string };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    expect(context.read('value')).toBe(1);

    context.write('extra', 'ok');

    expect(target.extra).toBe('ok');
  });
});
