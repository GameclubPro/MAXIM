import {
  createDuplicateCrashFixture,
  type CrashInput,
  type CrashStage,
} from './message-duplicate-crash-fixture';

// This process deliberately never closes its clients at a crash checkpoint: its parent
// must terminate it with SIGKILL and observe that signal before recovering any work.
async function checkpoint(name: string, details: Record<string, unknown> = {}): Promise<void> {
  const continued = new Promise<void>((resolve) => process.once('message', () => resolve()));
  process.send!({ name, ...details });
  await continued;
}

process.once('message', async (message: CrashInput & { stage: CrashStage }) => {
  let revocationCheckpoint: Promise<void> | undefined;
  const fixture = createDuplicateCrashFixture(
    message,
    message.stage === 'revocation'
      ? () => {
          revocationCheckpoint ??= checkpoint('revocation');
          return revocationCheckpoint;
        }
      : undefined,
  );
  try {
    if (message.stage === 'admission') {
      const admission = await fixture.admission.register({
        chatId: message.chatId,
        messageId: 'duplicate',
        jobId: fixture.identity.jobId,
      });
      await checkpoint('admission', { admission });
      throw new Error('Admission crash checkpoint must not continue');
    }
    const binding = await fixture.seed();
    if (message.stage === 'revocation') {
      await checkpoint('positive', { binding });
      await fixture.authorization.revoke({
        chatId: message.chatId,
        messageId: 'duplicate',
        senderId: '123',
        eventTimestampMs: message.eventTimestampMs,
      });
      throw new Error('Revocation crash checkpoint must not continue');
    }
    const claim = await fixture.intents.claimMessageActionBeforeQualification(
      fixture.claim,
      binding,
    );
    if (claim !== 'claimed') throw new Error(`Unexpected initial claim: ${claim}`);
    const qualified = await fixture.guard.qualify(fixture.target(binding));
    if (qualified === null) throw new Error('Fixture qualification must succeed');
    if (message.stage === 'qualification') {
      await checkpoint('qualification', { binding, qualified });
      throw new Error('Qualification crash checkpoint must not continue');
    }
    await checkpoint('before-intent', { binding, qualified });
    if (message.stage === 'intent') {
      const result = await fixture.handoff(binding);
      await checkpoint('intent', { intentId: result.intent?.intentId });
      throw new Error('Intent crash checkpoint must not continue');
    }
    const completed = await fixture.ordering.runInOrder(fixture.identity, true, async (lease) => {
      lease.assertOwned();
      return fixture.handoff(binding);
    });
    if (completed.kind !== 'completed') throw new Error('Fixture ordering did not complete');
    await checkpoint('completion', { completed });
    throw new Error('Completion crash checkpoint must not continue');
  } catch (error) {
    process.send?.({
      name: 'failure',
      error: error instanceof Error ? error.stack : String(error),
    });
    await fixture.close();
    process.exitCode = 1;
    process.disconnect?.();
  }
});
