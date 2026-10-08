import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCampaignRecipients } from './campaignRecipients.ts';

// Verbatim the table of src/modules/campaign/campaign-recipients.spec.ts on the gateway: the two parsers
// must accept the same entries, or the total confirmed on screen is not the total stored.
const CASES: Array<[string, string[]]> = [
  ['+55 (11) 98888-7777', ['5511988887777@c.us']],
  ['5511988887777', ['5511988887777@c.us']],
  ['5511988887777@c.us', ['5511988887777@c.us']],
  ['5511988887777@s.whatsapp.net', ['5511988887777@c.us']],
  ['5511988887777@S.WHATSAPP.NET', ['5511988887777@c.us']],
  ['+55 (11) 98888-7777\n5511988887777\n5511988887777@c.us', ['5511988887777@c.us']],
  ['111111,222222;333333\t444444', ['111111@c.us', '222222@c.us', '333333@c.us', '444444@c.us']],
  ['111111\r\n222222\r333333', ['111111@c.us', '222222@c.us', '333333@c.us']],
  ['1,628123456789', ['628123456789@c.us']],
  ['12345', []],
  ['123456', ['123456@c.us']],
  ['12345@c.us', []],
  ['ana@example.com', []],
  ['120363000000000000@g.us', []],
  ['55000111222333@lid', []],
  ['5511988887777:12@c.us', []],
  ['  \n , ;\t', []],
];

for (const [input, expected] of CASES) {
  test(`C2 reads ${JSON.stringify(input)} as the gateway does`, () => {
    assert.deepEqual(parseCampaignRecipients(input), expected);
  });
}

test('C2 counts the same phone once across lines, in first-seen order', () => {
  assert.deepEqual(
    parseCampaignRecipients('+55 (11) 98888-7777\n222222\n5511988887777\n5511988887777@s.whatsapp.net'),
    ['5511988887777@c.us', '222222@c.us'],
  );
});
