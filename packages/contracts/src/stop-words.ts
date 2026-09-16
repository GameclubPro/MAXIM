import { z } from 'zod';
import { broadcastImageSchema, MAX_BROADCAST_LINK_BUTTONS } from './broadcast-common.js';
import { normalizeHttpButtonUrl } from './button-url.js';

export const STOP_WORDS_RULES_MAX = 999;
export const STOP_WORDS_DOMAINS_MAX = 300;
export const STOP_WORDS_VALUE_MAX = 160;
export const STOP_WORDS_TOKENS_MAX = 16;

export function normalizeStopWordsValue(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
}

export function normalizeStopWordsDomain(value: string): string | null {
  const input = value.trim();
  if (!input || /[\s\p{Cf}\p{Cc}]/u.test(input)) return null;
  let domain: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    domain = url.hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return null;
  }
  if (!domain || domain.length > 253 || !domain.includes('.')) return null;
  if (domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    return null;
  }
  return domain;
}

export const stopWordsRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/u),
    kind: z.enum(['WORD', 'PHRASE']),
    value: z
      .string()
      .max(640, 'Запись слишком длинная.')
      .transform((value) => value.trim().replace(/\s+/gu, ' ')),
    enabled: z.boolean().default(true),
    matchMode: z.enum(['EXACT', 'MASKED']).default('EXACT'),
  })
  .superRefine((rule, ctx) => {
    const normalizedValue = normalizeStopWordsValue(rule.value);
    const tokens = normalizedValue.split(' ');
    if (
      rule.value.length < 2 ||
      rule.value.length > STOP_WORDS_VALUE_MAX ||
      normalizedValue.length > STOP_WORDS_VALUE_MAX ||
      tokens.length > STOP_WORDS_TOKENS_MAX ||
      !tokens.every((token) =>
        /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-'’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u.test(token),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'От 2 до 160 символов, не более 16 слов; без ссылок и служебных знаков.',
      });
    }
    if ((rule.kind === 'WORD') !== (tokens.length === 1)) {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'Тип записи должен соответствовать числу слов.',
      });
    }
  });
export type StopWordsRule = z.infer<typeof stopWordsRuleSchema>;

const buttonSchema = z.object({
  text: z.string().trim().min(1).max(32),
  url: z
    .string()
    .max(2_048)
    .refine((value) => Boolean(normalizeHttpButtonUrl(value)), 'Некорректная ссылка.'),
});
const messageSchema = z.string().max(1_000, 'До 1000 символов.').default('');
export const stopWordsMediaSchema = z
  .object({
    explanation: broadcastImageSchema.optional(),
    warning: broadcastImageSchema.optional(),
  })
  .default({});

export const stopWordsPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    enabled: z.boolean().default(false),
    rules: z
      .array(stopWordsRuleSchema)
      .max(STOP_WORDS_RULES_MAX, 'До 999 слов и фраз.')
      .default([]),
    domains: z
      .array(
        z
          .string()
          .max(2_048)
          .transform((value, ctx) => {
            const domain = normalizeStopWordsDomain(value);
            if (!domain) {
              ctx.addIssue({ code: 'custom', message: 'Укажите корректный домен или ссылку.' });
              return z.NEVER;
            }
            return domain;
          }),
      )
      .max(STOP_WORDS_DOMAINS_MAX, 'До 300 сайтов.')
      .default([]),
    imageScanEnabled: z.boolean().default(false),
    sanctions: z
      .object({
        botMessageEnabled: z.boolean().default(false),
        botMessageText: messageSchema,
        warnEnabled: z.boolean().default(false),
        warnMessageText: messageSchema,
        muteEnabled: z.boolean().default(false),
        muteDurationHours: z
          .number()
          .int('Укажите целое число часов.')
          .min(1, 'От 1 до 168 часов.')
          .max(168, 'От 1 до 168 часов.')
          .default(6),
        banEnabled: z.boolean().default(false),
        botButtonEnabled: z.boolean().default(false),
        botButtons: z
          .array(buttonSchema)
          .max(MAX_BROADCAST_LINK_BUTTONS, 'До 8 кнопок.')
          .default([]),
        adminContactButtonEnabled: z.boolean().default(false),
        adminContactButtonUrl: z.string().max(2_048).default(''),
        rulesButtonEnabled: z.boolean().default(false),
        media: stopWordsMediaSchema,
      })
      .prefault({}),
  })
  .superRefine((policy, ctx) => {
    const ids = new Set<string>();
    const values = new Set<string>();
    policy.rules.forEach((rule, index) => {
      const normalizedValue = normalizeStopWordsValue(rule.value);
      if (ids.has(rule.id) || values.has(normalizedValue)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index],
          message: 'Такая запись уже есть в списке.',
        });
      }
      ids.add(rule.id);
      values.add(normalizedValue);
    });
    if (new Set(policy.domains).size !== policy.domains.length) {
      ctx.addIssue({ code: 'custom', path: ['domains'], message: 'Домены не должны повторяться.' });
    }
    if (
      policy.sanctions.adminContactButtonEnabled &&
      !normalizeHttpButtonUrl(policy.sanctions.adminContactButtonUrl)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sanctions', 'adminContactButtonUrl'],
        message: 'Укажите ссылку для связи с администратором.',
      });
    }
    if (policy.sanctions.botButtonEnabled && policy.sanctions.botButtons.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['sanctions', 'botButtons'],
        message: 'Добавьте кнопку или выключите кнопки.',
      });
    }
  });
export type StopWordsPolicy = z.infer<typeof stopWordsPolicySchema>;

export const stopWordsStateSchema = z.object({
  policy: stopWordsPolicySchema,
  revision: z.number().int().nonnegative(),
  imageScanStatus: z.enum(['off', 'shadow', 'unavailable', 'ready']),
});
export type StopWordsState = z.infer<typeof stopWordsStateSchema>;
export const stopWordsStatusSchema = stopWordsStateSchema.omit({ policy: true });
export const updateStopWordsRequestSchema = z.object({
  policy: stopWordsPolicySchema,
  expectedRevision: z.number().int().nonnegative(),
});
export const stopWordsPreviewRequestSchema = z.object({
  policy: stopWordsPolicySchema,
  text: z.string().min(1).max(4_000),
});
export const stopWordsPreviewResponseSchema = z.object({
  enabled: z.boolean(),
  matches: z
    .array(
      z.object({
        ruleId: z.string(),
        value: z.string(),
        kind: z.enum(['WORD', 'PHRASE', 'DOMAIN']),
        matchKind: z.enum(['exact', 'masked', 'domain']),
        fragment: z.string(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      }),
    )
    .max(100),
});
export type StopWordsPreview = z.infer<typeof stopWordsPreviewResponseSchema>;
