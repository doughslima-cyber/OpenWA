/**
 * Read a campaign's recipient list into chat ids (OpenMsg). The dashboard runs the same rules
 * (dashboard/src/utils/campaignRecipients.ts) so the count the operator confirms is the count stored.
 *
 * The split is the Message Tester's (`parseBulkRecipients`): line endings and the comma, semicolon or
 * tab a spreadsheet export writes separate entries; spaces, parentheses, hyphens and a leading plus are
 * phone formatting inside one entry. On top of it a campaign takes phone numbers only, stored as
 * `<digits>@c.us`, because a reply is matched back to its recipient by number: a group, a lid, a
 * channel or a device id cannot be written in that form, so those entries are dropped.
 */

/** Fewest digits a phone number may carry, the bound the gateway and the session form already enforce. */
const MIN_PHONE_DIGITS = 6;

const FIELD_SEPARATORS = /[,;\t]/;

/** A phone in one of the two user-id dialects. Device (`:n`) and group (`-`) ids do not match. */
const USER_ID = /^([0-9]+)@(c\.us|s\.whatsapp\.net)$/i;

/** The phone an entry names as `<digits>@c.us`, or null when the entry is not a phone number. */
function toChatId(field: string): string | null {
  if (field.includes('@')) {
    const match = USER_ID.exec(field);
    return match && match[1].length >= MIN_PHONE_DIGITS ? `${match[1]}@c.us` : null;
  }
  const digits = field.replace(/[^0-9]/g, '');
  return digits.length >= MIN_PHONE_DIGITS ? `${digits}@c.us` : null;
}

/** Distinct accepted recipients, in first-seen order. Each entry may itself hold several lines or fields. */
export function parseCampaignRecipients(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const line of entry.split(/\r\n?|\n/)) {
      for (const raw of line.split(FIELD_SEPARATORS)) {
        const field = raw.trim();
        if (!field) continue;
        const chatId = toChatId(field);
        if (chatId) seen.add(chatId);
      }
    }
  }
  return [...seen];
}
