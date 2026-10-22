import { z } from 'zod';
import { channelSettingsSchema } from './channel-settings-field-schemas.js';
import { channelPostSignatureSettingsSchema } from './channel-post-signature.js';
import { managedEntityHeaderSchema } from './managed-entities.js';
import { managedBroadcastSummarySchema } from './managed-broadcast-summary.js';
export {
  channelSettingsSchema,
  channelSuggestionEntryModeSchema,
  type ChannelSettings,
  type ChannelSuggestionEntryMode,
} from './channel-settings-field-schemas.js';

export const channelSettingsScreenResponseSchema = z.object({
  settings: channelSettingsSchema,
  postSignature: channelPostSignatureSettingsSchema,
  header: managedEntityHeaderSchema,
  managedBroadcasts: z.array(managedBroadcastSummarySchema),
});

export type ChannelSettingsScreenResponse = z.infer<typeof channelSettingsScreenResponseSchema>;
