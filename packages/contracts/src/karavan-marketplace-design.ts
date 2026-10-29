import { z } from 'zod';
export const marketplaceHomeBlocksSchema = /* @__PURE__ */ (() =>
  z
    .array(
      z
        .object({
          id: z.enum(['categories', 'pinned', 'sellers']),
          visible: z.boolean(),
        })
        .strict(),
    )
    .length(3)
    .refine(
      (blocks) =>
        new Set(blocks.map((block) => block.id)).size === 3 &&
        blocks.some((block) => block.visible),
      'Выберите хотя бы один раздел',
    ))();
export const marketplaceAccentSchema = /* @__PURE__ */ (() =>
  z.enum(['blue', 'violet', 'teal', 'rose', 'graphite']))();
export const marketplaceAppearanceSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000).nullable(),
      logoImageUrl: z.string().url().max(2048).nullable(),
      coverImageUrl: z.string().url().max(2048).nullable(),
      accent: marketplaceAccentSchema,
      blocks: marketplaceHomeBlocksSchema,
    })
    .strict())();
export const marketplaceAppearanceResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    draft: marketplaceAppearanceSchema,
    published: marketplaceAppearanceSchema,
    revision: z.number().int().positive(),
    hasChanges: z.boolean(),
  }))();
export const marketplaceAppearanceSaveSchema = /* @__PURE__ */ (() =>
  z
    .object({
      commandId: z.string().min(8).max(120),
      expectedRevision: z.number().int().positive(),
      appearance: marketplaceAppearanceSchema,
    })
    .strict())();
export const marketplaceAppearancePublishSchema = /* @__PURE__ */ (() =>
  z
    .object({
      commandId: z.string().min(8).max(120),
      expectedRevision: z.number().int().positive(),
    })
    .strict())();
export const marketplaceOfferRefSchema = /* @__PURE__ */ (() =>
  z
    .object({
      id: z.string().uuid(),
      storeId: z.string().uuid(),
      kind: z.enum(['product', 'property']),
    })
    .strict())();
export const marketplacePinnedRefsSchema = /* @__PURE__ */ (() =>
  z
    .array(marketplaceOfferRefSchema)
    .max(24)
    .refine(
      (rows) => new Set(rows.map((row) => `${row.kind}:${row.id}`)).size === rows.length,
      'Объявление уже закреплено',
    ))();
export const marketplacePinsSaveSchema = /* @__PURE__ */ (() =>
  z
    .object({
      commandId: z.string().min(8).max(120),
      expectedRevision: z.number().int().positive(),
      offers: marketplacePinnedRefsSchema,
    })
    .strict())();
export const marketplaceOfferCardSchema = /* @__PURE__ */ (() =>
  marketplaceOfferRefSchema.extend({
    title: z.string(),
    storeName: z.string(),
    imageUrl: z.string().url().nullable(),
    available: z.boolean(),
    allowedCategory: z.boolean(),
    restriction: z
      .object({ revision: z.number().int().positive(), active: z.boolean(), reason: z.string() })
      .nullable(),
  }))();
export const marketplacePinsResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    revision: z.number().int().positive(),
    offers: z.array(marketplaceOfferCardSchema).max(24),
  }))();
export const marketplaceCatalogQuerySchema = /* @__PURE__ */ (() =>
  z
    .object({
      kind: z.enum(['product', 'property']).default('product'),
      q: z.string().trim().max(120).default(''),
      cursor: z.string().max(240).nullable().default(null),
      limit: z.number().int().min(1).max(48).default(24),
      visibility: z.enum(['all', 'visible', 'hidden']).default('all'),
      storeId: z.string().uuid().optional(),
    })
    .strict())();
export const marketplaceCatalogResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    items: z.array(marketplaceOfferCardSchema).max(48),
    nextCursor: z.string().nullable(),
  }))();
export type MarketplaceAppearance = z.infer<typeof marketplaceAppearanceSchema>;
export type MarketplaceOfferCard = z.infer<typeof marketplaceOfferCardSchema>;

export const marketplaceAdminImageSchema = /* @__PURE__ */ (() =>
  z
    .object({
      commandId: z.string().uuid(),
      fileName: z.string().min(1).max(160),
      mimeType: z.literal('image/jpeg'),
      dataBase64: z.string().min(1).max(700000),
    })
    .strict())();
export const marketplaceAdminImageResponseSchema = /* @__PURE__ */ (() =>
  z.object({ url: z.string().url() }))();
