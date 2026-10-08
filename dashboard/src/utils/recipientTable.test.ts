import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCampaignRecipients } from './campaignRecipients.ts';
import { columnLetter, columnValues, guessPhoneColumn, looksLikePhone, parseDelimited } from './recipientTable.ts';
import { readXlsx } from './xlsx.ts';
import { buildXlsx } from '../test-helpers/xlsx-fixture.ts';

test('a semicolon CSV with a quoted comma splits into its columns', () => {
  const rows = parseDelimited(
    'nome;telefone;cpf\r\n"Silva; Ana";+55 11 98888-7777;123.456.789-09\n\nBia;5511977776666;98765432100\n',
  );
  assert.deepEqual(rows, [
    ['nome', 'telefone', 'cpf'],
    ['Silva; Ana', '+55 11 98888-7777', '123.456.789-09'],
    ['Bia', '5511977776666', '98765432100'],
  ]);
});

test('a comma CSV and a tab file pick their own delimiter, and "" is an escaped quote', () => {
  assert.deepEqual(parseDelimited('a,"b ""x"", c",d'), [['a', 'b "x", c', 'd']]);
  assert.deepEqual(parseDelimited('a\tb\tc'), [['a', 'b', 'c']]);
  assert.deepEqual(parseDelimited('5511988887777\n5511977776666'), [['5511988887777'], ['5511977776666']]);
});

test('a phone looks like a phone; a CPF, a ZIP code and a name do not', () => {
  assert.equal(looksLikePhone('+55 (11) 98888-7777'), true);
  assert.equal(looksLikePhone('11988887777'), true);
  assert.equal(looksLikePhone('123.456.789-09'), false);
  assert.equal(looksLikePhone('01310-100'), false);
  assert.equal(looksLikePhone('Ana'), false);
});

test('the phone column is the one its header names, else the one with most phone-looking cells', () => {
  const named = [
    ['Pedido', 'Cliente', 'Celular'],
    ['12345678901', 'Ana', '11988887777'],
    ['12345678902', 'Bia', ''],
  ];
  assert.deepEqual(guessPhoneColumn(named), { column: 2, header: true });

  const unnamed = [
    ['Ana', '123.456.789-09', '+55 11 98888-7777'],
    ['Bia', '987.654.321-00', '+55 11 97777-6666'],
  ];
  assert.deepEqual(guessPhoneColumn(unnamed), { column: 2, header: false });
  assert.deepEqual(columnValues(unnamed, 2, false), ['+55 11 98888-7777', '+55 11 97777-6666']);
  assert.deepEqual(columnValues(named, 2, true), ['11988887777']);
});

test('column letters run A..Z then AA', () => {
  assert.deepEqual([0, 1, 25, 26, 27].map(columnLetter), ['A', 'B', 'Z', 'AA', 'AB']);
});

test('the first sheet of an .xlsx reads as rows, numbers as their digits', async () => {
  const bytes = buildXlsx([
    ['Nome', 'Telefone', 'CPF'],
    ['Ana & Cia', { n: '5511988887777' }, '123.456.789-09'],
    ['Bia', { n: '5.511977776666E+12' }, '987.654.321-00'],
  ]);
  const rows = await readXlsx(bytes.buffer as ArrayBuffer);
  assert.deepEqual(rows, [
    ['Nome', 'Telefone', 'CPF'],
    ['Ana & Cia', '5511988887777', '123.456.789-09'],
    ['Bia', '5511977776666', '987.654.321-00'],
  ]);
});

test('a file that is not a zip is refused with a readable error', async () => {
  await assert.rejects(() => readXlsx(new TextEncoder().encode('nome;telefone').buffer as ArrayBuffer), /not a zip/);
});

test('55 is added to a national Brazilian number, and only there', () => {
  const result = readCampaignRecipients(
    [
      '11988887777', // mobile with area code → 55
      '(11) 3333-4444', // landline with area code → 55
      '+1 202 555 0123', // explicit country code, kept
      '5511977776666', // already international, kept
      '11888887777', // 11 digits but not a mobile shape, kept
      '011988887777', // trunk prefix, kept
    ].join('\n'),
    { addBrazilCode: true },
  );
  assert.deepEqual(result.ids, [
    '5511988887777@c.us',
    '551133334444@c.us',
    '12025550123@c.us',
    '5511977776666@c.us',
    '11888887777@c.us',
    '011988887777@c.us',
  ]);
  assert.equal(result.withBrazilCode, 2);
});

test('without the option no number is changed', () => {
  assert.deepEqual(readCampaignRecipients('11988887777').ids, ['11988887777@c.us']);
  assert.equal(readCampaignRecipients('11988887777').withBrazilCode, 0);
});
