// Campaign recipients (OpenMsg). The same rules as the gateway's parser
// (src/modules/campaign/campaign-recipients.ts), so the total the operator confirms is the total stored.
// The split is the Message Tester's (`parseBulkRecipients`), repeated here because the Brazil rule below
// needs the entry as typed: a leading `+` says the country code is already there.

/** Most accepted numbers one campaign may hold (CAMPAIGN_RECIPIENTS_MAX on the gateway). */
export const CAMPAIGN_MAX_RECIPIENTS = 5000;

const MIN_PHONE_DIGITS = 6;
const FIELD_SEPARATORS = /[,;\t]/;
const USER_ID = /^([0-9]+)@(c\.us|s\.whatsapp\.net)$/i;

/**
 * A Brazilian number written without the country code: area code (two digits, neither 0) and an
 * 8-digit landline or a 9-digit mobile starting with 9. Ten or eleven digits in that shape are taken as
 * national; anything else is left as written.
 */
const BRAZIL_NATIONAL = /^(?:[1-9][1-9]\d{8}|[1-9][1-9]9\d{8})$/;

export interface CampaignRecipientsResult {
  /** Distinct accepted recipients as `<digits>@c.us`, in first-seen order. */
  ids: string[];
  /** How many of `ids` got the 55 country code added. */
  withBrazilCode: number;
}

/**
 * Read the recipient box into `<digits>@c.us` ids. Only phone numbers are taken, since a reply is
 * matched back to its recipient by number: groups, lids, channels and device ids are dropped, and the
 * two user dialects fold into one. With `addBrazilCode`, a national Brazilian number typed without a
 * leading `+` gets 55 in front.
 */
export function readCampaignRecipients(
  text: string,
  { addBrazilCode = false }: { addBrazilCode?: boolean } = {},
): CampaignRecipientsResult {
  const seen = new Set<string>();
  const adjusted = new Set<string>();
  for (const line of text.split(/\r\n?|\n/)) {
    for (const raw of line.split(FIELD_SEPARATORS)) {
      const field = raw.trim();
      if (!field) continue;
      if (field.includes('@')) {
        const match = USER_ID.exec(field);
        if (match && match[1].length >= MIN_PHONE_DIGITS) seen.add(`${match[1]}@c.us`);
        continue;
      }
      let digits = field.replace(/[^0-9]/g, '');
      if (digits.length < MIN_PHONE_DIGITS) continue;
      if (addBrazilCode && !field.startsWith('+') && BRAZIL_NATIONAL.test(digits)) {
        digits = `55${digits}`;
        adjusted.add(`${digits}@c.us`);
      }
      seen.add(`${digits}@c.us`);
    }
  }
  return { ids: [...seen], withBrazilCode: adjusted.size };
}

/** The gateway's rules exactly, with no country code added. */
export function parseCampaignRecipients(text: string): string[] {
  return readCampaignRecipients(text).ids;
}
