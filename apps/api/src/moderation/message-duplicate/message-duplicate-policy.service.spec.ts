import { ConfigService } from '@nestjs/config';
import {
  MessageDuplicatePolicyService,
  messageDuplicateControlSchema,
} from './message-duplicate-policy.service';

describe('message duplicate runtime policy', () => {
  const control = () => ({
    version: 1,
    revision: 1,
    mode: 'delete_only',
    chatIds: ['-123'],
    effectiveAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  });
  it('defaults off, validates all controls, and limits enforcement to the current cohort', async () => {
    const redis = { getString: jest.fn().mockResolvedValue(null) };
    const service = new MessageDuplicatePolicyService(redis as never, new ConfigService());
    expect(await service.resolve('-123', true)).toMatchObject({ mode: 'off' });
    redis.getString.mockResolvedValue(JSON.stringify(control()));
    expect(await service.resolve('-123', true)).toMatchObject({ mode: 'delete_only', revision: 1 });
    expect(await service.resolve('-456', true)).toMatchObject({ mode: 'off' });
    redis.getString.mockResolvedValue(
      JSON.stringify({ ...control(), expiresAt: new Date(Date.now() - 500).toISOString() }),
    );
    expect(await service.resolve('-123', true)).toMatchObject({ mode: 'off' });
    expect(
      messageDuplicateControlSchema.safeParse({
        ...control(),
        expiresAt: new Date(Date.now() + 86400001).toISOString(),
      }).success,
    ).toBe(false);
  });
  it('does not reuse cached authority for dispatch after a pause or read failure', async () => {
    const redis = { getString: jest.fn().mockResolvedValue(JSON.stringify(control())) };
    const service = new MessageDuplicatePolicyService(redis as never, new ConfigService());
    expect(await service.resolve('-123')).toMatchObject({ mode: 'delete_only' });
    redis.getString.mockResolvedValue(null);
    expect(await service.resolve('-123', true)).toMatchObject({ mode: 'off' });
    redis.getString.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.resolve('-123', true)).rejects.toThrow('could not be verified');
  });
  it('coalesces ordinary reads but performs an independent final authority check', async () => {
    let complete!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const redis = { getString: jest.fn().mockReturnValueOnce(pending).mockResolvedValue(null) };
    const service = new MessageDuplicatePolicyService(redis as never, new ConfigService());
    const first = service.resolve('-123');
    const second = service.resolve('-123');
    expect(await service.resolve('-123', true)).toMatchObject({ mode: 'off' });
    complete(JSON.stringify(control()));
    await first;
    await second;
    expect(redis.getString).toHaveBeenCalledTimes(2);
  });
});
