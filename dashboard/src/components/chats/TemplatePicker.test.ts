// Render test for the Cloud API template picker (OpenMsg, docs/32 F3) under the bare `node --test`
// runner, on the Users.test.ts harness: stubbed fetch, jsdom globals, the real English catalog.
// The picker lists the approved templates, asks for one value per body placeholder, previews the
// body, and posts the send with the parameters as an array (positional) or an object (named).
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const en = JSON.parse(readFileSync(new URL('../../i18n/locales/en.json', import.meta.url), 'utf8')) as {
  metaCloud: { templates: Record<string, string>; errors: Record<string, string> };
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const SESSION_ID = 'sess-cloud';
const CHAT_ID = '5511988887777@c.us';

const body = (text: string) => ({ type: 'BODY', text });
const tpl = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [body(`Body of ${name}`)],
  ...extra,
});

const ORDER_SHIPPED = tpl('order_shipped', { components: [body('Olá {{1}}, seu pedido {{2}} saiu')] });
const GREETING = tpl('greeting', {
  category: 'MARKETING',
  parameterFormat: 'NAMED',
  components: [body('Oi {{first_name}}')],
});
const PLAIN = tpl('plain_notice', { components: [body('Your order is ready')] });

let templates: unknown[] = [];
let listReply: (() => Response) | null = null;
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET' && path.startsWith(`/api/sessions/${SESSION_ID}/meta/templates`)) {
      return Promise.resolve(listReply ? listReply() : jsonResponse({ templates }));
    }
    if (method === 'POST' && path === `/api/sessions/${SESSION_ID}/meta/send-template`) {
      return Promise.resolve(jsonResponse({ messageId: 'wamid.T1', timestamp: 1_760_000_000 }, 201));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let TemplatePicker: (typeof import('./TemplatePicker.tsx'))['default'];
let ToastProvider: (typeof import('../Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;
let closed = 0;
let sent: Array<{ messageId: string; body: string }> = [];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../Toast.tsx'));
  ({ default: TemplatePicker } = await import('./TemplatePicker.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = undefined;
  templates = [];
  listReply = null;
  calls = [];
  closed = 0;
  sent = [];
});

function renderPicker(): void {
  queryClient?.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ToastProvider,
        null,
        createElement(TemplatePicker, {
          sessionId: SESSION_ID,
          chatId: CHAT_ID,
          onClose: () => {
            closed += 1;
          },
          onSent: (messageId: string, text: string) => {
            sent.push({ messageId, body: text });
          },
        }),
      ),
    ),
  );
}

const listCalls = () => calls.filter(c => c.method === 'GET' && c.path.includes('/meta/templates'));
const sendCalls = () => calls.filter(c => c.method === 'POST' && c.path.endsWith('/meta/send-template'));
const item = (name: string) => rtl.screen.getByRole('button', { name: new RegExp(`^${name}\\b`) });
const sendButton = () => rtl.screen.getByRole('button', { name: en.metaCloud.templates.send }) as HTMLButtonElement;

test('C35 lists only the approved templates, ordered by name then language, and Refresh reads again', async () => {
  templates = [
    tpl('zeta', { language: 'en_US', category: 'MARKETING' }),
    tpl('alpha', { language: 'pt_BR' }),
    tpl('pending_one', { status: 'PENDING' }),
    tpl('rejected_one', { status: 'REJECTED' }),
    tpl('alpha', { language: 'en_US', category: 'AUTHENTICATION' }),
  ];
  renderPicker();

  await rtl.screen.findAllByRole('button', { name: /^alpha\b/ });
  assert.equal(listCalls().length, 1);
  assert.equal(listCalls()[0].path, `/api/sessions/${SESSION_ID}/meta/templates`);

  const names = rtl.screen
    .getAllByRole('button')
    .filter(b => b.classList.contains('template-picker-item'))
    .map(b => b.textContent);
  assert.deepEqual(names, ['alphaen_USAUTHENTICATION', 'alphapt_BRUTILITY', 'zetaen_USMARKETING']);
  assert.equal(rtl.screen.queryByText('pending_one') === null, true);
  assert.equal(rtl.screen.queryByText('rejected_one') === null, true);

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: en.metaCloud.templates.refresh }));
  await rtl.waitFor(() => assert.equal(listCalls().length, 2));
  assert.equal(listCalls()[1].path, `/api/sessions/${SESSION_ID}/meta/templates?refresh=true`);
});

test('C36 shows one labelled input per placeholder and a live preview of the body', async () => {
  templates = [ORDER_SHIPPED, GREETING];
  renderPicker();

  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^order_shipped\b/ }));
  const first = rtl.screen.getByLabelText('{{1}}') as HTMLInputElement;
  const second = rtl.screen.getByLabelText('{{2}}') as HTMLInputElement;
  assert.equal(rtl.screen.queryByLabelText('{{3}}') === null, true);
  rtl.fireEvent.change(first, { target: { value: 'Ana' } });
  rtl.fireEvent.change(second, { target: { value: '42' } });
  assert.ok(rtl.screen.getByText('Olá Ana, seu pedido 42 saiu'));

  rtl.fireEvent.click(item('greeting'));
  assert.ok(rtl.screen.getByLabelText('{{first_name}}'));
  assert.equal(rtl.screen.queryByLabelText('{{1}}') === null, true);
});

test('C37 a header with media, a header with a variable and a button with a parameter are not sendable', async () => {
  const cases = [
    tpl('header_image', {
      components: [{ type: 'HEADER', format: 'IMAGE' }, body('Look at this')],
    }),
    tpl('header_variable', {
      components: [{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, body('Your order')],
    }),
    tpl('button_parameter', {
      components: [
        body('Track your order'),
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track', url: 'https://example.com/track/{{1}}' }] },
      ],
    }),
  ];
  templates = cases;
  renderPicker();
  await rtl.screen.findByRole('button', { name: /^header_image\b/ });

  for (const { name } of cases) {
    const row = item(name);
    assert.ok(row.textContent?.includes(en.metaCloud.templates.notSendable), `${name} is marked in the list`);
    rtl.fireEvent.click(row);
    assert.equal(sendButton().disabled, true, `${name} cannot be sent`);
  }
});

test('C38 with one of two inputs empty Send is disabled and clicking it sends nothing', async () => {
  templates = [ORDER_SHIPPED];
  renderPicker();

  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^order_shipped\b/ }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('{{1}}'), { target: { value: 'Ana' } });

  assert.equal(sendButton().disabled, true);
  rtl.fireEvent.click(sendButton());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sendCalls().length, 0);
});

test('C39 sends an array for a positional template, an object for a named one, and no parameters for none', async () => {
  templates = [ORDER_SHIPPED, GREETING, PLAIN];

  renderPicker();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^order_shipped\b/ }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('{{1}}'), { target: { value: 'Ana' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('{{2}}'), { target: { value: '42' } });
  rtl.fireEvent.click(sendButton());
  await rtl.waitFor(() => assert.equal(closed, 1));
  assert.deepEqual(sendCalls()[0].body, {
    chatId: CHAT_ID,
    name: 'order_shipped',
    language: 'pt_BR',
    parameters: ['Ana', '42'],
  });
  assert.deepEqual(sent, [{ messageId: 'wamid.T1', body: 'Olá Ana, seu pedido 42 saiu' }]);

  rtl.cleanup();
  renderPicker();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^greeting\b/ }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('{{first_name}}'), { target: { value: 'Ana' } });
  rtl.fireEvent.click(sendButton());
  await rtl.waitFor(() => assert.equal(closed, 2));
  assert.deepEqual(sendCalls()[1].body, {
    chatId: CHAT_ID,
    name: 'greeting',
    language: 'pt_BR',
    parameters: { first_name: 'Ana' },
  });

  rtl.cleanup();
  renderPicker();
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^plain_notice\b/ }));
  rtl.fireEvent.click(sendButton());
  await rtl.waitFor(() => assert.equal(closed, 3));
  assert.deepEqual(sendCalls()[2].body, { chatId: CHAT_ID, name: 'plain_notice', language: 'pt_BR' });
  assert.equal('parameters' in (sendCalls()[2].body as object), false);
});

test('C41 shows the WhatsApp Manager empty state, and on a failed list the error text and Refresh', async () => {
  templates = [tpl('waiting', { status: 'PENDING' })];
  renderPicker();
  assert.ok(await rtl.screen.findByText(en.metaCloud.templates.empty));
  assert.match(en.metaCloud.templates.empty, /WhatsApp Manager/);

  rtl.cleanup();
  listReply = () =>
    jsonResponse({ statusCode: 502, message: 'Graph API error: upstream down', code: 'META_UPSTREAM_ERROR' }, 502);
  renderPicker();
  assert.ok(await rtl.screen.findByText('Graph API error: upstream down'));
  assert.ok(rtl.screen.getByRole('button', { name: en.metaCloud.templates.refresh }));
});

test('C57 a list refused with META_TOKEN_MISSING shows the catalog text, not the server message', async () => {
  const serverMessage = 'The Cloud API session has no usable access token. Set one and restart it.';
  listReply = () => jsonResponse({ statusCode: 409, message: serverMessage, code: 'META_TOKEN_MISSING' }, 409);
  renderPicker();
  assert.ok(await rtl.screen.findByText(en.metaCloud.errors.META_TOKEN_MISSING));
  assert.equal(rtl.screen.queryByText(serverMessage) === null, true);
});

test('C60 a template with a CAROUSEL component, and one with a component type the picker does not know, are not sendable', async () => {
  templates = [
    tpl('carousel_offer', {
      components: [
        body('Veja nossas ofertas'),
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'IMAGE' },
                { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.test/{{1}}' }] },
              ],
            },
          ],
        },
      ],
    }),
    tpl('flash_sale', { components: [body('Oferta relâmpago'), { type: 'LIMITED_TIME_OFFER', text: 'Acaba hoje' }] }),
  ];
  renderPicker();
  for (const name of ['carousel_offer', 'flash_sale']) {
    await rtl.screen.findByText(/carousel_offer/);
    const row = item(name);
    assert.ok(row.textContent?.includes(en.metaCloud.templates.notSendable), `${name} is marked in the list`);
    rtl.fireEvent.click(row);
    assert.equal(sendButton().disabled, true, `${name} cannot be sent`);
  }
});
