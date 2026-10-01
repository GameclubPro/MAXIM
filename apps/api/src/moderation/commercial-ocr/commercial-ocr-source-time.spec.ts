import { extractCommercialOcrSourceCreatedAt } from './commercial-ocr-source-time';

describe('commercial OCR immutable source time', () => {
  const createdAt = '2026-08-12T08:00:00.000Z';

  it.each([Date.parse(createdAt), Date.parse(createdAt) / 1_000, createdAt, new Date(createdAt)])(
    'canonicalizes message creation time %p independently of the event clock',
    (timestamp) => {
      expect(
        extractCommercialOcrSourceCreatedAt({
          update_type: 'message_created',
          timestamp: Date.parse(createdAt) + 150,
          message: { timestamp },
        }),
      ).toBe(createdAt);
    },
  );

  it('never substitutes an outer event timestamp for a missing message timestamp', () => {
    expect(
      extractCommercialOcrSourceCreatedAt({
        update_type: 'message_created',
        timestamp: Date.parse(createdAt),
        message: { body: { text: 'photo' } },
      }),
    ).toBeNull();
    expect(
      extractCommercialOcrSourceCreatedAt({
        update_type: 'message_created',
        timestamp: Date.parse(createdAt),
      }),
    ).toBeNull();
  });

  it('uses the same timestamp for supported nested receipts and exact message rows', () => {
    const message = { body: { created_at: createdAt } };
    expect(extractCommercialOcrSourceCreatedAt({ event: { message } })).toBe(createdAt);
    expect(extractCommercialOcrSourceCreatedAt(message)).toBe(createdAt);
  });
});
