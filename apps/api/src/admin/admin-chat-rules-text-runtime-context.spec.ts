import { createAdminChatRulesTextRuntimeContext } from './admin-chat-rules-text-runtime-context';

describe('AdminChatRulesTextRuntimeContext', () => {
  it('reads and writes legacy target properties through a typed bridge', () => {
    const target = { value: 1 } as { value: number; extra?: string };
    const context = createAdminChatRulesTextRuntimeContext(target);

    expect(context.read('value')).toBe(1);

    context.write('extra', 'ok');

    expect(target.extra).toBe('ok');
  });
});
