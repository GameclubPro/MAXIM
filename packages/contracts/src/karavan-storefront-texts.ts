import { z } from 'zod';

export const KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH = 1000;
export const KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH = 64;

const storefrontButtonTextSchema = z
  .string()
  .trim()
  .max(KARAVAN_STOREFRONT_BUTTON_MAX_LENGTH)
  .refine(
    (value) => !/[\r\n\u2028\u2029]/u.test(value),
    'Подпись кнопки должна быть в одну строку.',
  )
  .default('');

export const karavanStorefrontTextSettingsShape = {
  karavanStorefrontMessageText: z
    .string()
    .trim()
    .max(KARAVAN_STOREFRONT_MESSAGE_MAX_LENGTH)
    .default(''),
  karavanStorefrontOpenButtonText: storefrontButtonTextSchema,
  karavanStorefrontCatalogButtonText: storefrontButtonTextSchema,
  karavanStorefrontCreateButtonText: storefrontButtonTextSchema,
};
