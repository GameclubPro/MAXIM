import { describe, expect, it } from 'vitest';
import {
  marketplaceBindingMetadataSchema,
  marketplaceProfileDetailsSchema,
  marketplaceProfileRelayResponseSchema,
  marketplaceStatisticRowSchema,
} from '../src/marketplace-integration.js';
import {
  exchangeEntitiesPageSchema,
  exchangeGrantEntitySchema,
  exchangeMeasurementIdentity,
  exchangeMeasurementKey,
  exchangeMeasurementSchema,
  exchangeMetricHealthSchema,
  exchangeStatisticsPageSchema,
} from '../src/statistics-exchange.js';
import {
  exchangeV3AccessPageSchema,
  exchangeV3AccessQuerySchema,
  exchangeV3ContentCanonical,
  exchangeV3ContentSchema,
  exchangeV3HealthSchema,
  exchangeV3MetadataSchema,
  exchangeV3StatisticsPageSchema,
  type ExchangeV3Content,
} from '../src/statistics-exchange-v3.js';

const id = '00000000-0000-4000-8000-000000000001';
const from = '2026-10-20T00:00:00.000Z';
const until = '2026-10-21T00:00:00.000Z';
const metadata = {
  title: 'Канал',
  description: 'Описание',
  imageUrl: null,
  publicUrl: null,
  audience: 100,
  isPublic: true,
};
const details = { title: 'Канал', description: 'Описание', topic: 'Тема', region: 'Регион' };
const relay = {
  bindingId: id,
  entityId: '-123',
  kind: 'CHANNEL',
  revision: 1,
  listing: { id, status: 'DRAFT', ...details, publicUrl: null, profileOnly: true },
  choices: { topics: [], regions: [] },
};
const entity = { entityId: '-123', kind: 'CHANNEL', profile: 'moderation' };
const manifest = {
  version: 2,
  grantId: id,
  grantRevision: 1,
  generationId: id,
  bindingId: id,
  entityId: '-123',
  kind: 'CHANNEL',
  origin: 'MAXIM',
  producerRevision: 1,
  method: 'utc-buckets-v1',
  from,
  to: until,
  asOf: until,
  rowCount: 0,
  sha256: '0'.repeat(64),
  complete: false,
  horizonToleranceSeconds: 900,
  metrics: [],
};
const accessPage = {
  version: 3,
  grantId: id,
  grantRevision: 1,
  accessRevision: 1,
  entities: [
    {
      ...entity,
      bindingId: null,
      bindingRevision: 0,
      status: 'UNAVAILABLE',
      checkedAt: null,
      validUntil: null,
      permittedScopes: [],
      isPublic: false,
      errorCode: null,
      metadataVersion: null,
    },
  ],
  nextCursor: null,
};

const timestampBoundaries: Array<[string, (value: string) => string | null]> = [
  [
    'v1 measurement',
    (value) =>
      marketplaceStatisticRowSchema.parse({
        metric: 'AUDIENCE',
        bucket: value,
        observedAt: value,
        value: 100,
      }).bucket,
  ],
  [
    'v2 health',
    (value) =>
      exchangeMetricHealthSchema.parse({
        metric: 'AUDIENCE',
        complete: false,
        checkedAt: value,
        nextExpectedAt: null,
        error: false,
      }).checkedAt,
  ],
  [
    'v3 health',
    (value) =>
      exchangeV3HealthSchema.parse({
        metric: 'AUDIENCE',
        checkedAt: value,
        lastObservationAt: value,
        nextExpectedAt: null,
        errorCode: null,
      }).checkedAt,
  ],
];

const limits: Array<{ name: string; maximum: number; parse: (value: string) => unknown }> = [
  ...(
    [
      ['title', 300],
      ['description', 4000],
    ] as const
  ).map(([field, maximum]) => ({
    name: `v1 metadata.${field}`,
    maximum,
    parse: (value: string) =>
      marketplaceBindingMetadataSchema.parse({ ...metadata, [field]: value }),
  })),
  ...(
    [
      ['title', 300],
      ['description', 1500],
      ['topic', 100],
      ['region', 80],
    ] as const
  ).flatMap(([field, maximum]) => [
    {
      name: `v1 details.${field}`,
      maximum,
      parse: (value: string) =>
        marketplaceProfileDetailsSchema.parse({ ...details, [field]: value }),
    },
    {
      name: `v1 listing.${field}`,
      maximum,
      parse: (value: string) =>
        marketplaceProfileRelayResponseSchema.parse({
          ...relay,
          listing: { ...relay.listing, [field]: value },
        }),
    },
  ]),
  ...(['topics', 'regions'] as const).map((field) => ({
    name: `v1 choices.${field}`,
    maximum: 100,
    parse: (value: string) =>
      marketplaceProfileRelayResponseSchema.parse({
        ...relay,
        choices: { ...relay.choices, [field]: [value] },
      }),
  })),
  {
    name: 'v2 entities cursor',
    maximum: 2048,
    parse: (value) => exchangeEntitiesPageSchema.parse({ entities: [], nextCursor: value }),
  },
  {
    name: 'v2 grant error',
    maximum: 300,
    parse: (value) =>
      exchangeGrantEntitySchema.parse({
        ...entity,
        status: 'UNAVAILABLE',
        binding: null,
        error: value,
      }),
  },
  {
    name: 'v2 statistics cursor',
    maximum: 2048,
    parse: (value) => exchangeStatisticsPageSchema.parse({ manifest, rows: [], nextCursor: value }),
  },
  {
    name: 'v3 access query cursor',
    maximum: 2048,
    parse: (value) => exchangeV3AccessQuerySchema.parse({ cursor: value }),
  },
  {
    name: 'v3 access page cursor',
    maximum: 2048,
    parse: (value) => exchangeV3AccessPageSchema.parse({ ...accessPage, nextCursor: value }),
  },
  {
    name: 'v3 inherited metadata title',
    maximum: 300,
    parse: (value) => exchangeV3MetadataSchema.parse({ ...metadata, title: value }),
  },
];

describe('marketplace validator upgrade compatibility', () => {
  for (const [name, parse] of timestampBoundaries) {
    it(`preserves UTC timestamp spellings through ${name}`, () => {
      for (const value of [
        '2026-10-20T00:00Z',
        '2026-10-20T00:00:00Z',
        '2026-10-20T00:00:00.0Z',
        from,
        '2026-10-20T00:00:00.123456789Z',
      ])
        expect(parse(value)).toBe(value);
    });
    it(`keeps offsets, local times and malformed timestamps out of ${name}`, () => {
      for (const value of [
        '2026-10-20T00:00+00:00',
        '2026-10-20T00:00:00+00:00',
        '2026-10-20T03:00:00+03:00',
        '2026-10-20T00:00',
        '2026-10-20',
        '2026-02-30T00:00Z',
        '2026-10-20T24:00Z',
        '2026-10-20T00:60Z',
        '2026-10-20T00:00:60Z',
        '2026-10-20T00:00:00.Z',
        '2026-10-20t00:00:00z',
        '2026-10-20T00:00:00Z\n',
      ])
        expect(() => parse(value)).toThrow();
    });
  }

  it.each(limits)('preserves the UTF-16 limit for $name', ({ maximum, parse }) => {
    const emoji = '😀'.repeat(maximum / 2);
    expect(() => parse('Я'.repeat(maximum))).not.toThrow();
    expect(() => parse(emoji)).not.toThrow();
    for (const value of [`a${emoji}`, 'Я'.repeat(maximum + 1)]) {
      let failure: unknown;
      try {
        parse(value);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        issues: [{ code: 'too_big', origin: 'string', maximum, inclusive: true }],
      });
    }
  });

  it('keeps trimming before the profile limit and preserves positive-string lower bounds', () => {
    const title = '😀'.repeat(150);
    expect(marketplaceProfileDetailsSchema.parse({ ...details, title: `  ${title}  ` }).title).toBe(
      title,
    );
    expect(marketplaceProfileDetailsSchema.parse({ ...details, description: '' }).description).toBe(
      '',
    );
    for (const field of ['title', 'topic', 'region']) {
      expect(marketplaceProfileDetailsSchema.safeParse({ ...details, [field]: '  ' }).success).toBe(
        false,
      );
      expect(
        marketplaceProfileDetailsSchema.safeParse({ ...details, [field]: ' 😀 ' }).success,
      ).toBe(true);
    }
    expect(
      exchangeGrantEntitySchema.safeParse({
        ...entity,
        entityId: '-😀',
        status: 'UNAVAILABLE',
        binding: null,
        error: null,
      }).success,
    ).toBe(false);
  });

  it('preserves producer spelling and canonical content while recognizing minute-bucket identity', () => {
    const minute = '2026-10-20T00:00Z';
    const row = exchangeMeasurementSchema.parse({
      origin: 'MAXIM',
      method: 'utc-buckets-v1',
      revision: 1,
      data: { metric: 'AUDIENCE', bucket: minute, observedAt: minute, value: 100 },
    });
    expect(row.data.bucket).toBe(minute);
    expect(exchangeMeasurementKey(row)).toBe(`AUDIENCE:${minute}:`);
    expect(exchangeMeasurementIdentity(row)).toBe(
      exchangeMeasurementIdentity({
        ...row,
        data: { ...row.data, bucket: from },
      }),
    );
    const content: ExchangeV3Content = {
      generationId: id,
      contentHash: '0'.repeat(64),
      producerRevision: 1,
      origin: 'MAXIM',
      method: 'utc-buckets-v1',
      from: minute,
      to: until,
      asOf: until,
      rowCount: 0,
      pageCount: 0,
      sha256: '0'.repeat(64),
      scopes: [],
      horizonToleranceSeconds: 900,
    };
    const parsed = exchangeV3ContentSchema.parse(content);
    expect(parsed).toEqual(content);
    expect(exchangeV3ContentCanonical(parsed)).toBe(exchangeV3ContentCanonical(content));
  });

  it('rejects oversized v2 and v3 pages before reading any invalid row', () => {
    const row = Object.defineProperty({}, 'origin', {
      enumerable: true,
      get() {
        throw new Error('Oversized page read a row');
      },
    });
    const rows = Array.from({ length: 201 }, () => row);
    expect(
      exchangeStatisticsPageSchema.safeParse({ manifest, rows, nextCursor: null }).success,
    ).toBe(false);
    expect(
      exchangeV3StatisticsPageSchema.safeParse({
        version: 3,
        generationId: id,
        contentHash: '0'.repeat(64),
        pageIndex: 0,
        rows,
        nextPageIndex: null,
      }).success,
    ).toBe(false);
  });
});
