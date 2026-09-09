import { describe, expect, it } from 'vitest';
import { publicationContentInputSchema, publicationPostPublishSchema } from '../src/publication.js';

describe('publication post-publish policy', () => {
  it('keeps older clients and stored content opt-out by default', () => {
    expect(publicationPostPublishSchema.parse({})).toEqual({
      pin: 'none',
      deleteAfterMinutes: null,
    });
    expect(publicationContentInputSchema.parse({ text: 'Post' }).postPublish).toBeUndefined();
  });

  it.each(['none', 'silent', 'notify'])('accepts %s pin mode independently of deletion', (pin) => {
    expect(publicationPostPublishSchema.parse({ pin, deleteAfterMinutes: 60 })).toEqual({
      pin,
      deleteAfterMinutes: 60,
    });
  });

  it.each([0, -1, 0.5, 43_201, '60', Infinity])(
    'rejects unsafe deletion delay %s',
    (deleteAfterMinutes) => {
      expect(publicationPostPublishSchema.safeParse({ deleteAfterMinutes }).success).toBe(false);
    },
  );

  it.each([1, 43_200])('accepts boundary delay %s', (deleteAfterMinutes) => {
    expect(publicationPostPublishSchema.safeParse({ deleteAfterMinutes }).success).toBe(true);
  });
});
