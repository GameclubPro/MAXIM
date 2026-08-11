import { z } from 'zod';

import {
  allowlistMatchTypeSchema,
  NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH,
  navigationAllowlistKindSchema,
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  normalizeStoredNavigationAllowlistEntry,
  resolveLegacyAllowlistMatchType,
} from './settings-utils.js';

export const addDomainRequestSchema = z
  .object({
    domain: z.string().trim().min(1).max(NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH),
    kind: navigationAllowlistKindSchema.optional(),
    matchType: allowlistMatchTypeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind &&
      value.matchType &&
      resolveLegacyAllowlistMatchType(value.kind) !== value.matchType
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Тип цели не совпадает с устаревшим типом сопоставления.',
        path: ['matchType'],
      });
      return;
    }

    const inputKind = value.kind ?? value.matchType;
    const normalized =
      inputKind !== undefined
        ? normalizeStoredNavigationAllowlistEntry(value.domain, inputKind)
        : (normalizeAllowlistLink(value.domain) ?? normalizeAllowlistDomain(value.domain));

    if (normalized) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        inputKind === 'DOMAIN' || inputKind === 'WEB_DOMAIN'
          ? 'Укажите корректный домен.'
          : inputKind === 'EXACT' || inputKind === 'WEB_EXACT'
            ? 'Укажите корректную ссылку (http/https).'
            : inputKind === 'MAX_PROFILE'
              ? 'Укажите числовой ID профиля MAX или ссылку user/<id>.'
              : inputKind === 'MAX_ENTITY'
                ? 'Укажите официальную ссылку чата или канала MAX.'
                : inputKind === 'MINI_APP'
                  ? 'Укажите корректную ссылку мини-приложения MAX.'
                  : 'Укажите корректную ссылку или домен.',
      path: ['domain'],
    });
  });

export const navigationAllowlistEntrySchema = z
  .object({
    domain: z.string().trim().min(3).max(NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH),
    target: z.string().trim().min(3).max(NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH).optional(),
    normalizedValue: z.string().trim().min(3).max(NAVIGATION_ALLOWLIST_STORED_VALUE_MAX_LENGTH),
    matchType: allowlistMatchTypeSchema,
    kind: navigationAllowlistKindSchema.optional(),
    removeAfterAt: z.string().datetime().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind && resolveLegacyAllowlistMatchType(value.kind) !== value.matchType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Тип цели не совпадает с устаревшим типом сопоставления.',
        path: ['matchType'],
      });
    }
  });
export type NavigationAllowlistEntry = z.infer<typeof navigationAllowlistEntrySchema>;
export const domainAllowlistEntrySchema = navigationAllowlistEntrySchema;
export type DomainAllowlistEntry = NavigationAllowlistEntry;

export const scheduleDomainRemovalRequestSchema = z.object({
  removeAfterAt: z.string().datetime().nullable(),
});
