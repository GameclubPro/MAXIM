import { z } from 'zod';

export const advertisingCapabilitySchema = z.object({ available: z.boolean() });
export const advertisingChatIdSchema = z.string().regex(/^-[1-9]\d{0,19}$/u);
export const advertisingListingSchema = z.object({
  id: z.string().uuid(),
  chatId: advertisingChatIdSchema,
  title: z.string().min(1).max(300),
  url: z.string().url(),
});
export const advertisingLookupSchema = z.object({
  listing: advertisingListingSchema.nullable(),
  connectUrl: z.string().url(),
});
export const advertisingSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const advertisingSendInputSchema = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().positive(),
    previousSendId: z.string().uuid().nullable(),
    acknowledgeUncertain: z.boolean().default(false),
  })
  .strict();
export const advertisingSendSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['SENDING', 'SENT', 'FAILED', 'UNCERTAIN']),
  createdAt: z.string().datetime(),
});
export const advertisingStateSchema = z.object({
  enabled: z.boolean(),
  bindingCurrent: z.boolean().default(false),
  revision: z.number().int().nonnegative(),
  listing: advertisingListingSchema.nullable(),
  connectUrl: z.string().url(),
  lookupFailed: z.boolean(),
  lastSend: advertisingSendSchema.nullable(),
});
export type AdvertisingState = z.infer<typeof advertisingStateSchema>;
export type AdvertisingSend = z.infer<typeof advertisingSendSchema>;
