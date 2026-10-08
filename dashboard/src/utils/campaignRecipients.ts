// Campaign recipients (OpenMsg). The same rules as the gateway's parser
// (src/modules/campaign/campaign-recipients.ts), so the total the operator confirms is the total stored.
import { parseBulkRecipients } from './bulkRecipients.ts';

/** Most accepted numbers one campaign may hold (CAMPAIGN_RECIPIENTS_MAX on the gateway). */
export const CAMPAIGN_MAX_RECIPIENTS = 5000;

const MIN_PHONE_DIGITS = 6;
const USER_ID = /^([0-9]+)@(c\.us|s\.whatsapp\.net)$/i;

/**
 * Read the recipient box into `<digits>@c.us` ids: the Message Tester's split and phone rules, plus the
 * campaign's own: only phone numbers are taken, since a reply is matched back to its recipient by
 * number. Groups, lids, channels and device ids are dropped; the two user dialects fold into one.
 */
export function parseCampaignRecipients(text: string): string[] {
  const seen = new Set<string>();
  for (const id of parseBulkRecipients(text)) {
    const match = USER_ID.exec(id);
    if (match && match[1].length >= MIN_PHONE_DIGITS) seen.add(`${match[1]}@c.us`);
  }
  return [...seen];
}
