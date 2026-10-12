// Render tests for a WhatsApp Cloud API session on the Chats page (OpenMsg, docs/32 F3), on the
// Chats.test.ts harness: stubbed fetch, jsdom globals, the real English catalog, an admin role, the
// login engine in sessionStorage. A Cloud session hides what the Cloud API refuses, asks the 24-hour
// window of the open chat, and offers Send template; a QR session is unchanged.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, ChatMessage, Session } from '../services/api';
import { lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const en = JSON.parse(readFileSync(new URL('../i18n/locales/en.json', import.meta.url), 'utf8')) as {
  chats: { tab: Record<string, string>; actions: Record<string, string>; channels: Record<string, string> };
  metaCloud: { window: Record<string, string>; templates: Record<string, string>; errors: Record<string, string> };
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const CLOUD: Session = {
  ...base,
  id: 'cloud-1',
  name: 'Cloud',
  engine: 'meta-cloud',
  status: 'ready',
  phone: '5511999990000',
};
const QR: Session = {
  ...base,
  id: 'qr-1',
  name: 'Phone',
  engine: 'whatsapp-web.js',
  status: 'ready',
  phone: '15551234567',
};

const CHAT: Chat = {
  id: '5511988887777@c.us',
  name: 'Ana',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_760_000_000,
  lastMessage: 'oi',
  archived: false,
  pinned: false,
  muted: false,
};

const OWN: ChatMessage = {
  id: 'db-own',
  waMessageId: 'wamid.OWN',
  chatId: CHAT.id,
  from: 'me',
  to: CHAT.id,
  body: 'my own message',
  type: 'text',
  direction: 'outgoing',
  status: 'sent',
  timestamp: 1_760_000_000,
  createdAt: new Date(1_760_000_000_000).toISOString(),
};
const PROMPT: ChatMessage = {
  ...OWN,
  id: 'db-prompt',
  waMessageId: 'wamid.PROMPT',
  from: CHAT.id,
  to: 'me',
  body: 'pick one',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_760_000_001,
  createdAt: new Date(1_760_000_001_000).toISOString(),
  metadata: { buttons: [{ id: 'yes', text: 'Yes please' }] },
};
const SENT_TEMPLATE: ChatMessage = {
  ...OWN,
  id: 'db-template',
  waMessageId: 'wamid.T1',
  body: 'Olá Ana, seu pedido 42 saiu',
  timestamp: 1_760_000_002,
  createdAt: new Date(1_760_000_002_000).toISOString(),
};

let session: Session = CLOUD;
let messages: ChatMessage[] = [];
let windowReply: () => Response = () => jsonResponse({ lastInboundAt: null, open: false, closesAt: null });
let sendReply: () => Response = () => jsonResponse({ messageId: 'wamid.OUT', timestamp: 1_760_000_100 }, 201);
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const sid = session.id;

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([session]));
    if (method === 'GET' && path === '/api/infra/engines/current') {
      return Promise.resolve(jsonResponse({ engineType: window.sessionStorage.getItem('openwa_engine_type') }));
    }
    if (method === 'GET' && path === `/api/sessions/${sid}/chats`) return Promise.resolve(jsonResponse([CHAT]));
    if (method === 'GET' && path.startsWith(`/api/sessions/${sid}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    if (method === 'GET' && /\/contacts\/[^/]+\/profile-picture$/.test(path)) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path.startsWith(`/api/sessions/${sid}/messages?`)) {
      return Promise.resolve(jsonResponse({ messages, total: messages.length }));
    }
    if (method === 'GET' && /\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(jsonResponse([]));
    if (method === 'POST' && path === `/api/sessions/${sid}/chats/read`)
      return Promise.resolve(jsonResponse({ success: true }));
    if (method === 'GET' && path === `/api/sessions/${sid}/channels`) return Promise.resolve(jsonResponse([]));
    if (method === 'GET' && path === `/api/sessions/${sid}/status`)
      return Promise.resolve(jsonResponse({ statuses: [] }));
    if (method === 'POST' && path === `/api/sessions/${sid}/messages/send-text`) return Promise.resolve(sendReply());
    if (method === 'GET' && path.startsWith(`/api/sessions/${sid}/meta/chats/`)) return Promise.resolve(windowReply());
    if (method === 'GET' && path.startsWith(`/api/sessions/${sid}/meta/templates`)) {
      return Promise.resolve(
        jsonResponse({
          templates: [
            {
              name: 'order_shipped',
              language: 'pt_BR',
              status: 'APPROVED',
              category: 'UTILITY',
              parameterFormat: 'POSITIONAL',
              components: [{ type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} saiu' }],
            },
          ],
        }),
      );
    }
    if (method === 'POST' && path === `/api/sessions/${sid}/meta/send-template`) {
      // From now on the stored history holds the template, as the gateway's row does.
      messages = [...messages, SENT_TEMPLATE];
      return Promise.resolve(jsonResponse({ messageId: 'wamid.T1', timestamp: 1_760_000_002 }, 201));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  resetSocketDouble();
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = undefined;
  session = CLOUD;
  messages = [];
  windowReply = () => jsonResponse({ lastInboundAt: null, open: false, closesAt: null });
  sendReply = () => jsonResponse({ messageId: 'wamid.OUT', timestamp: 1_760_000_100 }, 201);
  calls = [];
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
});

async function renderChats(): Promise<void> {
  // A test that renders twice drops the first client here: its avatar queries hold 30-minute gc timers.
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  await rtl.screen.findByText('Ana');
}

async function openChat(): Promise<void> {
  rtl.fireEvent.click(rtl.screen.getByText('Ana'));
  await rtl.waitFor(() => assert.ok(document.querySelector('.message-text-input')));
}

const tab = (name: string) => rtl.screen.queryByRole('tab', { name });
const windowCalls = () => calls.filter(c => c.method === 'GET' && c.path.includes('/meta/chats/'));
const banner = () => document.querySelector('.meta-cloud-window-banner');
const sendTemplateButtons = () => rtl.screen.queryAllByRole('button', { name: en.metaCloud.templates.open });
const textInput = () => document.querySelector('.message-text-input') as HTMLInputElement;

test('C15 a Cloud session shows no Status and no Channels tab', async () => {
  await renderChats();

  assert.ok(tab(en.chats.tab.chats));
  assert.equal(tab(en.chats.tab.status) === null, true);
  assert.equal(tab(en.chats.tab.channels) === null, true);
});

test('C16 a Cloud message menu keeps Reply and React without Delete, and prompt buttons are plain labels', async () => {
  messages = [OWN, PROMPT];
  windowReply = () => jsonResponse({ lastInboundAt: null, open: true, closesAt: null });
  await renderChats();
  await openChat();

  await rtl.screen.findByText('my own message');
  const menus = [...document.querySelectorAll('.message-actions-menu')];
  const ownMenu = menus.find(m => m.parentElement?.textContent?.includes('my own message'))!;
  assert.ok(ownMenu, 'the own message has a menu');
  assert.ok(rtl.within(ownMenu as HTMLElement).getByRole('button', { name: en.chats.actions.reply }));
  assert.ok(rtl.within(ownMenu as HTMLElement).getByRole('button', { name: en.chats.actions.react }));
  assert.equal(
    rtl.within(ownMenu as HTMLElement).queryByRole('button', { name: en.chats.actions.delete }) === null,
    true,
  );

  const label = rtl.screen.getByText('Yes please');
  assert.equal(label.closest('button') === null, true, 'the prompt choice is no button');
  const prompts = document.querySelector('.message-prompt-buttons')!;
  assert.equal(prompts.querySelectorAll('button').length, 0);
});

test('C17 opening a Cloud chat requests its window once', async () => {
  await renderChats();
  await openChat();

  await rtl.waitFor(() => assert.equal(windowCalls().length, 1));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(windowCalls().length, 1);
  assert.equal(windowCalls()[0].path, `/api/sessions/${CLOUD.id}/meta/chats/${encodeURIComponent(CHAT.id)}/window`);
});

test('C18 a closed window shows the banner with Send template inside it', async () => {
  windowReply = () =>
    jsonResponse({ lastInboundAt: '2026-10-10T10:00:00.000Z', open: false, closesAt: '2026-10-11T10:00:00.000Z' });
  await renderChats();
  await openChat();

  const text = await rtl.screen.findByText(en.metaCloud.window.closed);
  const bannerEl = text.closest('.meta-cloud-window-banner') as HTMLElement;
  assert.ok(bannerEl);
  assert.ok(rtl.within(bannerEl).getByRole('button', { name: en.metaCloud.templates.open }));
});

test('C19 an open window shows no banner and offers Send template; a failed window read shows no banner', async () => {
  windowReply = () =>
    jsonResponse({ lastInboundAt: '2026-10-12T10:00:00.000Z', open: true, closesAt: '2026-10-13T10:00:00.000Z' });
  await renderChats();
  await openChat();
  await rtl.waitFor(() => assert.equal(windowCalls().length, 1));
  await rtl.waitFor(() => assert.equal(sendTemplateButtons().length, 1));
  assert.equal(banner() === null, true);
  assert.equal(sendTemplateButtons()[0].closest('.room-input-footer, .meta-cloud-template-action') !== null, true);

  rtl.cleanup();
  calls = [];
  windowReply = () => jsonResponse({ statusCode: 500, message: 'boom' }, 500);
  await renderChats();
  await openChat();
  await rtl.waitFor(() => assert.equal(windowCalls().length, 1));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(banner() === null, true);
  assert.equal(rtl.screen.queryByText(en.metaCloud.window.closed) === null, true);
  assert.equal(textInput().disabled, false);
});

test('C20 a send refused with a Cloud code shows that code’s catalog text', async () => {
  windowReply = () => jsonResponse({ lastInboundAt: null, open: true, closesAt: null });
  const codes: Array<[number, string]> = [
    [409, 'META_OUTSIDE_SERVICE_WINDOW'],
    [400, 'META_RECIPIENT_UNAVAILABLE'],
    [429, 'META_LIMIT_REACHED'],
    [429, 'META_RATE_LIMITED'],
    [409, 'META_TOKEN_INVALID'],
    [409, 'META_ACCOUNT_RESTRICTED'],
  ];
  for (const [status, code] of codes) {
    rtl.cleanup();
    sendReply = () => jsonResponse({ statusCode: status, message: `raw ${code}`, code }, status);
    await renderChats();
    await openChat();
    rtl.fireEvent.change(textInput(), { target: { value: `hello ${code}` } });
    rtl.fireEvent.submit(textInput().closest('form')!);
    assert.ok(await rtl.screen.findByText(en.metaCloud.errors[code]), code);
  }
});

test('C21 a NULL-engine session keeps its tabs, Delete and composer, and asks no window', async () => {
  session = QR;
  messages = [OWN];
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  await renderChats();

  assert.ok(tab(en.chats.tab.status));
  assert.ok(tab(en.chats.tab.channels));
  await openChat();
  await rtl.screen.findByText('my own message');
  const menus = [...document.querySelectorAll('.message-actions-menu')];
  const ownMenu = menus.find(m => m.parentElement?.textContent?.includes('my own message')) as HTMLElement;
  assert.ok(rtl.within(ownMenu).getByRole('button', { name: en.chats.actions.delete }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(windowCalls().length, 0);
  assert.equal(banner() === null, true);
  assert.equal(sendTemplateButtons().length, 0);

  rtl.cleanup();
  session = { ...QR, engine: 'baileys' };
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  await renderChats();
  rtl.fireEvent.click(tab(en.chats.tab.channels)!);
  assert.ok(await rtl.screen.findByText(en.chats.channels.notSupported));
});

test('C40 after a picker send the thread refetches and shows the sent message', async () => {
  windowReply = () => jsonResponse({ lastInboundAt: null, open: false, closesAt: null });
  await renderChats();
  await openChat();

  const text = await rtl.screen.findByText(en.metaCloud.window.closed);
  const bannerEl = text.closest('.meta-cloud-window-banner') as HTMLElement;
  rtl.fireEvent.click(rtl.within(bannerEl).getByRole('button', { name: en.metaCloud.templates.open }));
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /^order_shipped\b/ }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('{{1}}'), { target: { value: 'Ana' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('{{2}}'), { target: { value: '42' } });
  const picker = document.querySelector('.template-picker') as HTMLElement;
  rtl.fireEvent.click(rtl.within(picker).getByRole('button', { name: en.metaCloud.templates.send }));

  await rtl.waitFor(() => assert.equal(document.querySelector('.template-picker') === null, true));
  const thread = document.querySelector('.room-messages') as HTMLElement;
  assert.ok(await rtl.within(thread).findByText('Olá Ana, seu pedido 42 saiu'));
});

test('C58 a customer message arriving in the open Cloud chat reads its window again and clears the closed banner', async () => {
  windowReply = () =>
    jsonResponse({ lastInboundAt: '2026-10-10T10:00:00.000Z', open: false, closesAt: '2026-10-11T10:00:00.000Z' });
  await renderChats();
  await openChat();
  assert.ok(await rtl.screen.findByText(en.metaCloud.window.closed));
  assert.equal(windowCalls().length, 1);

  const inboundAt = new Date();
  windowReply = () =>
    jsonResponse({
      lastInboundAt: inboundAt.toISOString(),
      open: true,
      closesAt: new Date(inboundAt.getTime() + 24 * 3600 * 1000).toISOString(),
    });
  const socket = lastSocket();
  assert.ok(socket, 'expected the page to have opened a socket');
  socket.receive('message', {
    type: 'event',
    timestamp: inboundAt.toISOString(),
    payload: {
      event: 'message.received',
      sessionId: CLOUD.id,
      data: {
        id: 'wamid.live.reply',
        chatId: CHAT.id,
        from: CHAT.id,
        to: 'me',
        body: 'Oi, ainda estou esperando',
        type: 'text',
        fromMe: false,
        timestamp: Math.floor(inboundAt.getTime() / 1000),
      },
    },
  });

  await rtl.waitFor(() => assert.equal(windowCalls().length, 2));
  await rtl.waitFor(() => assert.equal(banner() === null, true));
});

test('C59 an open window is read again once its closesAt passes, and the closed banner then shows', async () => {
  const closesAt = new Date(Date.now() + 1500);
  windowReply = () =>
    jsonResponse({
      lastInboundAt: new Date(closesAt.getTime() - 24 * 3600 * 1000).toISOString(),
      open: true,
      closesAt: closesAt.toISOString(),
    });
  await renderChats();
  await openChat();
  await rtl.waitFor(() => assert.equal(windowCalls().length, 1));
  assert.equal(banner() === null, true);

  windowReply = () =>
    jsonResponse({
      lastInboundAt: new Date(closesAt.getTime() - 24 * 3600 * 1000).toISOString(),
      open: false,
      closesAt: closesAt.toISOString(),
    });
  await rtl.waitFor(() => assert.equal(windowCalls().length, 2), { timeout: 6000 });
  assert.ok(await rtl.screen.findByText(en.metaCloud.window.closed));
});
