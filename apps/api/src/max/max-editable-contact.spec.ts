import { normalizeEditableContactPayload } from './max-editable-contact';
import { assertEditableAttachmentsPreserved } from './max-editable-message-preservation';

const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Test Contact\r\nTEL:+12025550123\r\nEND:VCARD\r\n';
const contact = (payload: unknown) => ({ type: 'contact', payload });

describe('editable contact preservation', () => {
  it.each([
    [
      { max_info: { user_id: 123, first_name: 'Test', last_name: 'Contact' } },
      { contact_id: '123', name: 'Test Contact' },
    ],
    [
      { max_info: { user_id: '9223372036854775807', name: 'Exact label' } },
      { contact_id: '9223372036854775807', name: 'Exact label' },
    ],
    [
      { contact_id: '123', max_info: { user_id: 123, name: 'Profile' }, name: 'Custom  label' },
      { contact_id: '123', name: 'Custom  label' },
    ],
    [
      { contact_id: '123', name: '' },
      { contact_id: '123', name: '' },
    ],
    [{ max_info: { user_id: 123 }, vcf_info: '', hash: 'response-hash' }, { contact_id: '123' }],
    [
      { vcf_info: vcard, max_info: null, hash: 'response-hash', name: 'Saved name' },
      { vcf_info: vcard, name: 'Saved name' },
    ],
  ])('preserves the exact contact identity and display data for %j', (source, expected) => {
    expect(normalizeEditableContactPayload(source)).toEqual(expected);
    expect(() =>
      assertEditableAttachmentsPreserved([contact(source)], [contact(expected)], []),
    ).not.toThrow();
  });

  it.each([
    null,
    [],
    {},
    { max_info: {} },
    { max_info: { user_id: Number.MAX_SAFE_INTEGER + 1 } },
    { contact_id: '-123' },
    { contact_id: '1.2' },
    { contact_id: '9223372036854775808' },
    { contact_id: '123', max_info: { user_id: 456 } },
    { contact_id: '123', vcf_info: vcard },
    { vcf_info: 'BEGIN:VCARD' },
    { vcf_info: '' },
    { max_info: { user_id: 123 }, phone: '+12025550123' },
    { max_info: { user_id: 123, unknown: 'preserve me' } },
    { contact_id: '123', name: 42 },
    { vcf_info: vcard, hash: {} },
  ])('refuses ambiguous or incomplete contact data instead of dropping it: %j', (source) => {
    expect(() => normalizeEditableContactPayload(source)).toThrow(
      'Contact data cannot be preserved',
    );
  });

  it.each([
    { contact_id: '456', name: 'Saved' },
    { contact_id: '123', name: 'Changed' },
    { contact_id: '123' },
    { max_info: { user_id: 123, name: 'Saved' } },
    { contact_id: '123', name: 'Saved', extra: true },
  ])('rejects a replacement that changes identity, label or outgoing format: %j', (replacement) => {
    expect(() =>
      assertEditableAttachmentsPreserved(
        [contact({ max_info: { user_id: 123, name: 'Saved' } })],
        [contact(replacement)],
        [],
      ),
    ).toThrow('would be lost');
  });

  it('does not accept a changed vCard or relax preservation of other media', () => {
    expect(() =>
      assertEditableAttachmentsPreserved(
        [contact({ vcf_info: vcard })],
        [contact({ vcf_info: vcard.replace('12025550123', '12025550124') })],
        [],
      ),
    ).toThrow('would be lost');
    expect(() =>
      assertEditableAttachmentsPreserved(
        [{ type: 'image', payload: { token: 'original' } }],
        [{ type: 'image', payload: { token: 'different' } }],
        [],
      ),
    ).toThrow('would be lost');
  });
});
