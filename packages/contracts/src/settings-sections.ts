import { z } from 'zod';

export const applySettingsSectionSchema = z.enum([
  'reports',
  'links',
  'greeting',
  'profanityFilter',
  'commercialFilter',
  'duplicates',
  'limits',
  'stopWords',
  'phones',
  'night',
  'requiredSubscription',
  'invitationAccess',
  'commands',
  'storefront',
  'extra',
]);
export type ApplySettingsSection = z.infer<typeof applySettingsSectionSchema>;
