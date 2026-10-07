import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SOURCE_INVENTORY_DATE_COLUMNS,
  SourceInventoryRefused,
  sourceInventoryPrismaRow,
} from './source-abandonment-sql-row';
import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';

describe('source inventory SQL row decoding', () => {
  it('covers exactly the schema DateTime columns in every admitted table', () => {
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gmu)];
    for (const [table, columns] of Object.entries(SOURCE_INVENTORY_DATE_COLUMNS)) {
      const matches = models.filter(([, , body]) => body.includes(`@@map("${table}")`));
      expect(matches).toHaveLength(1);
      const fields = matches[0]![2]!
        .split('\n')
        .filter((line) => /^\s*\w+\s+DateTime[?\s]/u.test(line));
      const expected = fields.map((line) => {
        const name = /^\s*(\w+)/u.exec(line)![1]!;
        return /@map\("([^"]+)"\)/u.exec(line)?.[1] ?? name;
      });
      expect([...columns].sort()).toEqual(expected.sort());
    }
  });

  it.each(['', '2027-01-02T03:04:05.000Z', 'not a date'])(
    'preserves string expiry %j and converts actual dates without changing JSON',
    (expiry) => {
      const nested = { created_at: 'kept as JSON', required_subscription_expires_at: expiry };
      const row = sourceInventoryPrismaRow('chat_settings', {
        required_subscription_expires_at: expiry,
        created_at: '2026-10-07T05:35:00',
        updated_at: '2026-10-07T08:35:00+03:00',
        link_policy_effective_at: null,
        bot_speech_media: nested,
      });
      expect(row).toEqual({
        requiredSubscriptionExpiresAt: expiry,
        createdAt: new Date('2026-10-07T05:35:00Z'),
        updatedAt: new Date('2026-10-07T05:35:00Z'),
        linkPolicyEffectiveAt: null,
        botSpeechMedia: nested,
      });
      expect(row.botSpeechMedia).toBe(nested);
      expect(() => sourceAbandonmentDigest(row)).not.toThrow();
    },
  );

  it('preserves valid Date instances and null', () => {
    const at = new Date('2026-10-07T05:35:00Z');
    const row = sourceInventoryPrismaRow('chat_settings', {
      created_at: at,
      link_policy_effective_at: null,
    });
    expect(row.createdAt).toBe(at);
    expect(row.linkPolicyEffectiveAt).toBeNull();
  });

  it.each(['', 'not a date', 'infinity', new Date(NaN), 123, true, false, {}, undefined])(
    'refuses invalid schema DateTime value %p with a stable code',
    (value) => {
      expect(() => sourceInventoryPrismaRow('chat_settings', { created_at: value })).toThrow(
        new SourceInventoryRefused('sql_date_value_unproved'),
      );
    },
  );

  it.each(['toString', '__proto__', 'unknown_table'])(
    'refuses an unregistered table %s',
    (table) => {
      expect(() => sourceInventoryPrismaRow(table, {})).toThrow(
        new SourceInventoryRefused('sql_descriptor_invalid'),
      );
    },
  );
});
