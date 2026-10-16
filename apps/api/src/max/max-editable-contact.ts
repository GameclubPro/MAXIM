import { BadRequestException } from '@nestjs/common';

const PAYLOAD_FIELDS = new Set(['contact_id', 'max_info', 'vcf_info', 'name', 'hash']);
const PROFILE_FIELDS = new Set([
  'user_id',
  'first_name',
  'last_name',
  'name',
  'is_bot',
  'last_activity_time',
]);

function refuse(): never {
  throw new BadRequestException('Contact data cannot be preserved; preserving the original post.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
    return refuse();
  return id;
}

function optionalName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return refuse();
  return value;
}

/** Convert a MAX contact response to its documented outgoing representation. */
export function normalizeEditableContactPayload(value: unknown): Record<string, unknown> {
  const payload = record(value);
  if (Object.keys(payload).some((key) => !PAYLOAD_FIELDS.has(key))) return refuse();
  const profile = payload.max_info == null ? null : record(payload.max_info);
  if (profile && Object.keys(profile).some((key) => !PROFILE_FIELDS.has(key))) return refuse();
  const directId = payload.contact_id == null ? null : identifier(payload.contact_id);
  const profileId = profile ? identifier(profile.user_id) : null;
  if (directId && profileId && directId !== profileId) return refuse();
  const contactId = directId ?? profileId;
  const vcard = payload.vcf_info == null || payload.vcf_info === '' ? null : payload.vcf_info;
  if (
    vcard !== null &&
    (typeof vcard !== 'string' ||
      !/^BEGIN:VCARD(?:\r\n|\n|\r)/i.test(vcard) ||
      !/(?:\r\n|\n|\r)END:VCARD(?:\r\n|\n|\r)?$/i.test(vcard))
  )
    return refuse();
  // FLAG: An id and a vCard are distinct representations. Never guess which source
  // identity to discard, fabricate a phone number, or silently drop unknown fields.
  if ((!contactId && !vcard) || (contactId && vcard)) return refuse();
  if (payload.hash != null && typeof payload.hash !== 'string') return refuse();
  const profileName = profile
    ? (optionalName(profile.name) ??
      ([optionalName(profile.first_name), optionalName(profile.last_name)]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' ') ||
        undefined))
    : undefined;
  const name = optionalName(payload.name) ?? profileName;
  // FLAG: max_info/hash are response metadata. The exact id or vCard and supplied
  // display name remain content; strict preservation compares this complete payload.
  return {
    ...(contactId ? { contact_id: contactId } : { vcf_info: vcard }),
    ...(name !== undefined ? { name } : {}),
  };
}
