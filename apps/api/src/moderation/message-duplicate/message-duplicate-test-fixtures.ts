import { chatSettingsSchema } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';

// Recorded from 4b894214 before concatenated electrical-unit protection (text v13).
export const preElectricalUnitSettingsDigests = {
  STANDARD: '80afd87616b636a8e53fb54611a92afe76e6f94b4b8135d48a652c7ffc4ba193',
  STRICT: '16e9cdad93fdc45c98c02a21702b635cc0a0a476d70f3f5fa71dd50894336a15',
  CUSTOM_NEAR: 'deef7f691598051275b294fcdb652c8439c8479b7d6e5a59df72f64e3086064a',
  CUSTOM_PHONE: '23a624482c552505d82d270d4fcac4822aec2ab205d2c225c766f2171f476133',
  IMAGE: 'fcd5021c58ff1a6917c53f0465e6b7a3108f16c84f891df77e1be3a4b5da07b5',
} as const;

// Recorded from main 7b1755f8 before prefix-unit and compact international-phone protection.
export const prePrefixUnitSettingsDigests = {
  STANDARD: 'c92ad98dee750420e35b14c6816bd84db749e35c3f8e1fb93a220b7d76fd93c6',
  STRICT: 'cc7fa2d58da4882e0ee204ccbf27ce814195d6c6895a09d621ffda5ccb4803fd',
  CUSTOM_NEAR: '1e986483a3bcbc2775596c7980591e0cbe40c94866d5aac05d016bdf245cd0f8',
  CUSTOM_PHONE: '490fa1769a4d482e6c86563ff43d635ab8e3fbbc3b761032eb5300e8841a9aad',
  IMAGE: 'fcd5021c58ff1a6917c53f0465e6b7a3108f16c84f891df77e1be3a4b5da07b5',
} as const;

// Recorded from main 356a3d5a before case-sensitive numeric quantity-unit protection.
export const preSemanticUnitSettingsDigests = {
  STANDARD: '5ca1fb72c354a099340722db667672f96c03533096f16ee68b88fd7e0742a7ba',
  STRICT: '9d116043810b95777d9bbc6f12e36dff93972f86b15fb3ec1cc57964ffb87875',
  CUSTOM_NEAR: '74d3f8593a16761dcc1cfc092d0a704b51bc5801e4322374711b1b083415cb18',
  CUSTOM_PHONE: '04cb3129576bd4163fa70e6916a24e5007842a9652402e5932eb7e5fd0cc5eb9',
  IMAGE: 'fcd5021c58ff1a6917c53f0465e6b7a3108f16c84f891df77e1be3a4b5da07b5',
} as const;

// Recorded from main 377936b2 before the v3 history incarnation and padded-context guard.
export const preV3HistorySettingsDigests = {
  STANDARD: 'abacbcc44c2a0dd8f0177b92124fe503b37960065ca14a7bfba61c5663006780',
  STRICT: '2690ef5fc8cfb957311ae9332bf890437a5e9afad9527ce59d0619ee2bbc9484',
  CUSTOM_NEAR: '5b7b2d13806d5cc160c56692841ee0f3c5d2c18cdd7697265a99ba26d4df8919',
  CUSTOM_PHONE: '95a387169ed0fd8d1d742b1cb96e564e767f931a3843ae66e48a0c67f3103e11',
  IMAGE: '8b9112c31be1ae76f2304014f60b97d49c0d20063b37db7ac43fd3e7a72eaaa4',
} as const;

// Recorded from the pre-Unicode matcher at 1333fa9 with duplicateSettings below.
export const preUnicodeNearSettingsDigests = {
  STRICT: '1a1c2877f9325e5f2563d675c4ad27c05b097bdcf22210205525f4be1ea06da5',
  CUSTOM: '0f816f04439405d78f988f0eefe7b353cb29d650365aa6c9b6fd6be5598d65d0',
} as const;

// Recorded before conservative phone evidence/internal punctuation at the v6 settings fence.
export const preSafeTextSettingsDigests = {
  STRICT: 'c06758cff6d8639bbe465fcd54b7a0b1aeb9d7115791f10025ee97b827a04c15',
  CUSTOM_NEAR: '04c88045d7a64dbea9096ead840a2ccb8d5a8d0b206ce1588b2dd9fe2a225655',
  CUSTOM_PHONE: '98a9f5799b58c3d38147b6228ab73583621b394074a5942fd6e231905d61b284',
} as const;

// Recorded at the v7 settings fence before bounded phone labels (helper v2).
export const preBoundedPhoneSettingsDigests = {
  STRICT: '47521512f757fbe1943c24e302afe81e09d3632b945c86bae5f9da78afdc7dbf',
  CUSTOM_NEAR: '41464350d04a50407a8dbd26808c08e6cb435b88be1a7fc95cd25199791f2922',
  CUSTOM_PHONE: '0aa2f1282c4e0692fac91d2ff455fecd2d8c19414d562809b8c5047d3730e23d',
} as const;

// Recorded at the v8 settings fence before raw identifier and URL phone boundaries.
export const prePhoneBoundarySettingsDigests = {
  STRICT: '892b514d2a8add26b6b0d7d136a798862c9ebafdc99c3a63b0b01565d4da3f0e',
  CUSTOM_NEAR: 'd3c0cb77e05c10e5a170ee3504e4958994f952ff14e13c6db9d8461fc5c8f4f3',
  CUSTOM_PHONE: '4ccdf485d90b61b1aec8f654c23240c384dcd8a3b3cc76462a194acd41d2b318',
} as const;

// Recorded at the v9 fence before source-bound stripping and numeric/phone-span protection.
export const preSourceBoundPhoneSettingsDigests = {
  STRICT: '23c6d8705f96598118048a504f18dee476d8dcf4b5a306a611bbf6eaddb35ef0',
  CUSTOM_NEAR: 'ae6d5172357c34dc377d43a9d1e3b732beba7814308c1482b53e1a87e54bd81f',
  CUSTOM_PHONE: '451a6a535e3fe18e7908285ee382c0e5481c838c917c8b9ba5525e2899e0c8b7',
} as const;

export function duplicateSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...chatSettingsSchema.parse({}),
    duplicateDetectionPreset: 'STANDARD',
    antiDuplicateEnabled: true,
    duplicatePolicyRevision: 0,
    duplicateHistoryRevision: 0,
    duplicateCompareMode: 'MESSAGE',
    duplicatePhotoEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateWarnEnabled: false,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
    duplicateWarnMaxCount: 1,
    ...overrides,
  } as ChatSettings;
}

export function duplicateUpdate(
  messageId = 'm2',
  timestamp = Date.now() - 1000,
  text = 'a',
  attachments: unknown[] = [],
) {
  return new WebhookParser().parse({
    update_type: 'message_created',
    timestamp,
    message: {
      sender: { user_id: 123, name: 'Test' },
      recipient: { chat_id: -123, chat_type: 'chat' },
      timestamp,
      body: { mid: messageId, text, attachments },
    },
  });
}
