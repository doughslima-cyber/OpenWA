// Render tests for WhatsApp Cloud API sessions on the Sessions page (OpenMsg, docs/32 F3), on the
// Sessions.test.ts harness: stubbed fetch, jsdom globals, the real English catalog, an admin role.
// A Cloud session is created from the form, has no QR and no Unlink, and its detail reads and rotates
// the account through GET/PUT .../meta/account.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '../services/api';

const en = JSON.parse(readFileSync(new URL('../i18n/locales/en.json', import.meta.url), 'utf8')) as {
  common: Record<string, string>;
  sessions: {
    newSession: string;
    actions: Record<string, string>;
    details: Record<string, string>;
    qr: Record<string, string>;
  };
  metaCloud: {
    engine: Record<string, string>;
    fields: Record<string, string>;
    badge: string;
    tokenHint: string;
    account: Record<string, string>;
    errors: Record<string, string>;
  };
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const CLOUD_STARTING: Session = {
  ...base,
  id: 'cloud-starting-id',
  name: 'cloud-starting',
  engine: 'meta-cloud',
  status: 'initializing',
  engineLoaded: true,
  phone: null,
};
const CLOUD_READY: Session = {
  ...base,
  id: 'cloud-ready-id',
  name: 'cloud-ready',
  engine: 'meta-cloud',
  status: 'ready',
  engineLoaded: true,
  phone: '5511999990000',
};
const CLOUD_STOPPED: Session = {
  ...base,
  id: 'cloud-stopped-id',
  name: 'cloud-stopped',
  engine: 'meta-cloud',
  status: 'created',
  engineLoaded: false,
  phone: null,
};
const CLOUD_TOKEN_INVALID: Session = {
  ...base,
  id: 'cloud-invalid-id',
  name: 'cloud-token-invalid',
  engine: 'meta-cloud',
  status: 'action_required',
  engineLoaded: true,
  lastError: 'META_TOKEN_INVALID',
};
const CLOUD_TOKEN_MISSING: Session = {
  ...CLOUD_TOKEN_INVALID,
  id: 'cloud-missing-id',
  name: 'cloud-token-missing',
  lastError: 'META_TOKEN_MISSING',
};
const QR_SESSION: Session = {
  ...base,
  id: 'qr-device-id',
  name: 'qr-device',
  status: 'qr_ready',
  engineLoaded: true,
  phone: null,
};

const ACCOUNT = {
  phoneNumberId: '106540352242922',
  wabaId: '102290129340398',
  displayPhoneNumber: '+55 11 99999-0000',
  verifiedName: 'Acme',
  qualityRating: 'GREEN',
  messagingLimitTier: 'TIER_1K',
  accessTokenLast4: '1234',
  webhookUrl: 'https://openmsg.example.com/api/meta-webhook',
};

let sessions: Session[] = [];
let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let createReply: (() => Response) | null = null;
let accountReply: (() => Response) | null = null;
let putReply: ((token: string) => Response) | null = null;

const fresh = () =>
  [CLOUD_STARTING, CLOUD_READY, CLOUD_STOPPED, CLOUD_TOKEN_INVALID, CLOUD_TOKEN_MISSING, QR_SESSION].map(s => ({
    ...s,
  }));

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse(sessions));
    if (method === 'POST' && path === '/api/sessions') {
      if (createReply) return Promise.resolve(createReply());
      const name = (body as { name: string }).name;
      return Promise.resolve(
        jsonResponse({ ...base, id: `new-${name}`, name, engine: 'meta-cloud', status: 'created' }),
      );
    }
    const account = path.match(/^\/api\/sessions\/([^/]+)\/meta\/account$/);
    if (account && method === 'GET') return Promise.resolve(accountReply ? accountReply() : jsonResponse(ACCOUNT));
    if (account && method === 'PUT') {
      const token = (body as { accessToken: string }).accessToken;
      if (putReply) return Promise.resolve(putReply(token));
      return Promise.resolve(jsonResponse({ ...ACCOUNT, accessTokenLast4: token.slice(-4) }));
    }
    if (/^\/api\/sessions\/[^/]+\/config$/.test(path)) {
      return Promise.resolve(
        jsonResponse({ autoRejectCalls: false, maxReconnectAttempts: null, reconnectBaseDelay: 5000 }),
      );
    }
    const lifecycle = path.match(/^\/api\/sessions\/([^/]+)\/start$/);
    if (lifecycle && method === 'POST') {
      const row = sessions.find(s => s.id === lifecycle[1])!;
      // The engine is up and still starting, which on a QR session is when the QR modal opens.
      Object.assign(row, { status: 'initializing', engineLoaded: true });
      return Promise.resolve(jsonResponse(row));
    }
    if (/\/qr$/.test(path))
      return Promise.resolve(jsonResponse({ qrCode: 'data:image/png;base64,FAKE', status: 'qr_ready' }));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Sessions: (typeof import('./Sessions.tsx'))['Sessions'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  // Admin: canWrite and the proxy section of the create form are both on.
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Sessions } = await import('./Sessions.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = undefined;
  calls = [];
  createReply = null;
  accountReply = null;
  putReply = null;
});

async function renderSessions(): Promise<void> {
  sessions = fresh();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Sessions))),
    ),
  );
  await rtl.screen.findByText('cloud-ready');
}

const cardOf = (name: string) => rtl.screen.getByText(name).closest('.session-card') as HTMLElement;
const sessionPosts = () => calls.filter(c => c.method === 'POST' && c.path === '/api/sessions');
const createButton = () => rtl.screen.getByRole('button', { name: en.common.create }) as HTMLButtonElement;

function openCreate(): void {
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: en.sessions.newSession }));
}

function fillCloud(name: string, fields: { phoneNumberId: string; wabaId: string; accessToken: string }): void {
  const { screen, fireEvent } = rtl;
  fireEvent.change(screen.getByLabelText('Session Name'), { target: { value: name } });
  fireEvent.click(screen.getByLabelText(en.metaCloud.engine.cloud));
  fireEvent.change(screen.getByLabelText(en.metaCloud.fields.phoneNumberId), {
    target: { value: fields.phoneNumberId },
  });
  fireEvent.change(screen.getByLabelText(en.metaCloud.fields.wabaId), { target: { value: fields.wabaId } });
  fireEvent.change(screen.getByLabelText(en.metaCloud.fields.accessToken), {
    target: { value: fields.accessToken },
  });
}

const FIELDS = { phoneNumberId: '106540352242922', wabaId: '102290129340398', accessToken: 'EAAG-secret-token-9999' };

test('C2 the New session form offers QR (checked) and the official Meta API, with no Cloud field until chosen', async () => {
  await renderSessions();
  openCreate();

  const qr = rtl.screen.getByLabelText(en.metaCloud.engine.qr) as HTMLInputElement;
  const cloud = rtl.screen.getByLabelText(en.metaCloud.engine.cloud) as HTMLInputElement;
  assert.equal(qr.checked, true);
  assert.equal(cloud.checked, false);
  assert.equal(rtl.screen.queryByLabelText(en.metaCloud.fields.phoneNumberId), null);
  assert.equal(rtl.screen.queryByLabelText(en.metaCloud.fields.wabaId), null);
  assert.equal(rtl.screen.queryByLabelText(en.metaCloud.fields.accessToken), null);
});

test('C3 choosing the official Meta API shows the three labelled fields, the token as a password', async () => {
  await renderSessions();
  openCreate();
  rtl.fireEvent.click(rtl.screen.getByLabelText(en.metaCloud.engine.cloud));

  const phone = rtl.screen.getByLabelText(en.metaCloud.fields.phoneNumberId) as HTMLInputElement;
  const waba = rtl.screen.getByLabelText(en.metaCloud.fields.wabaId) as HTMLInputElement;
  const token = rtl.screen.getByLabelText(en.metaCloud.fields.accessToken) as HTMLInputElement;
  assert.equal(phone.tagName, 'INPUT');
  assert.equal(waba.tagName, 'INPUT');
  assert.equal(token.type, 'password');
});

test('C4 submitting the Cloud form posts name, engine and metaCloud once, with no proxy field', async () => {
  await renderSessions();
  openCreate();
  fillCloud('cloud-new', FIELDS);
  rtl.fireEvent.click(createButton());

  await rtl.waitFor(() => assert.equal(sessionPosts().length, 1));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sessionPosts().length, 1);
  assert.deepEqual(sessionPosts()[0].body, { name: 'cloud-new', engine: 'meta-cloud', metaCloud: FIELDS });
  assert.equal('proxyUrl' in (sessionPosts()[0].body as object), false);
});

test('C5 with any Cloud field empty the submit is disabled and sends nothing', async () => {
  await renderSessions();
  for (const empty of ['phoneNumberId', 'wabaId', 'accessToken'] as const) {
    rtl.cleanup();
    await renderSessions();
    openCreate();
    fillCloud('cloud-partial', { ...FIELDS, [empty]: '' });

    assert.equal(createButton().disabled, true, `${empty} empty`);
    rtl.fireEvent.click(createButton());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sessionPosts().length, 0, `${empty} empty sent nothing`);
  }
});

test('C6 a create refused with a Cloud code shows the catalog text, not the response message', async () => {
  const cases: Array<[number, string]> = [
    [400, 'META_CLOUD_DISABLED'],
    [400, 'META_CLOUD_NOT_CONFIGURED'],
    [409, 'META_PHONE_NUMBER_IN_USE'],
  ];
  for (const [status, code] of cases) {
    rtl.cleanup();
    createReply = () => jsonResponse({ statusCode: status, message: `raw server text ${code}`, code }, status);
    await renderSessions();
    openCreate();
    fillCloud('cloud-refused', FIELDS);
    rtl.fireEvent.click(createButton());

    const shown = await rtl.screen.findAllByText(en.metaCloud.errors[code]);
    assert.ok(shown.length > 0, code);
    assert.equal(rtl.screen.queryByText(`raw server text ${code}`), null, `${code} hides the raw message`);
  }
});

test('C7 a Cloud card shows the Official API badge and no QR placeholder, Show QR or Unlink', async () => {
  await renderSessions();

  for (const name of ['cloud-starting', 'cloud-ready']) {
    const card = cardOf(name);
    assert.ok(rtl.within(card).getByText(en.metaCloud.badge), `${name} badge`);
    assert.equal(card.querySelector('.qr-placeholder'), null, `${name} placeholder`);
    assert.equal(rtl.within(card).queryByRole('button', { name: en.sessions.qr.showQr }), null, `${name} Show QR`);
    assert.equal(rtl.within(card).queryByRole('button', { name: en.sessions.actions.unlink }), null, `${name} Unlink`);
  }
  assert.ok(rtl.within(cardOf('qr-device')).getByRole('button', { name: en.sessions.qr.showQr }));
});

test('C8 starting a Cloud session opens no QR modal and requests no QR', async () => {
  await renderSessions();

  rtl.fireEvent.click(rtl.within(cardOf('cloud-stopped')).getByRole('button', { name: en.sessions.actions.start }));
  await rtl.waitFor(() =>
    assert.ok(calls.some(c => c.method === 'POST' && c.path === `/api/sessions/${CLOUD_STOPPED.id}/start`)),
  );
  // Room for the post-start re-read and any modal it would open.
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.equal(document.querySelector('.qr-modal'), null);
  assert.equal(
    calls.some(c => c.path.endsWith('/qr')),
    false,
  );
});

test('C9 a Cloud card needing a new token shows the change-the-token hint', async () => {
  await renderSessions();

  for (const name of ['cloud-token-invalid', 'cloud-token-missing']) {
    assert.ok(rtl.within(cardOf(name)).getByText(en.metaCloud.tokenHint), name);
  }
});

async function openDetail(name: string): Promise<HTMLElement> {
  rtl.fireEvent.click(rtl.within(cardOf(name)).getByRole('button', { name: en.sessions.actions.view }));
  return (await rtl.screen.findByRole('dialog')) as HTMLElement;
}

test('C10 a Cloud detail shows the account from GET .../meta/account, the masked token and the webhook URL', async () => {
  await renderSessions();
  const dialog = await openDetail('cloud-ready');

  await rtl.within(dialog).findByText('+55 11 99999-0000');
  assert.ok(calls.some(c => c.method === 'GET' && c.path === `/api/sessions/${CLOUD_READY.id}/meta/account`));
  for (const text of ['Acme', 'GREEN', 'TIER_1K', '•••• 1234', ACCOUNT.webhookUrl]) {
    assert.ok(rtl.within(dialog).getByText(text), text);
  }
  assert.ok(rtl.within(dialog).getByRole('button', { name: en.metaCloud.account.copy }));
  assert.ok(rtl.within(dialog).getByText(/META_WEBHOOK_VERIFY_TOKEN/));
});

test('C11 a Cloud detail shows no auto-reject-calls toggle', async () => {
  await renderSessions();
  const dialog = await openDetail('cloud-ready');
  await rtl.within(dialog).findByText('+55 11 99999-0000');

  assert.equal(rtl.within(dialog).queryByText(en.sessions.details.autoRejectCalls), null);
});

test('C12 Change token sends exactly the new token, confirms, empties the field and shows the new last 4', async () => {
  await renderSessions();
  const dialog = await openDetail('cloud-ready');
  await rtl.within(dialog).findByText('•••• 1234');

  const input = rtl.within(dialog).getByLabelText(en.metaCloud.account.newToken) as HTMLInputElement;
  const button = rtl
    .within(dialog)
    .getByRole('button', { name: en.metaCloud.account.changeToken }) as HTMLButtonElement;
  assert.equal(button.disabled, true);

  rtl.fireEvent.change(input, { target: { value: 'new-token-5678' } });
  rtl.fireEvent.click(button);

  await rtl.within(dialog).findByText('•••• 5678');
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/api/sessions/${CLOUD_READY.id}/meta/account`);
  assert.deepEqual(puts[0].body, { accessToken: 'new-token-5678' });
  assert.ok(await rtl.screen.findByText(en.metaCloud.account.tokenChanged));
  assert.equal(input.value, '');
});

test('C13 a failed account read or token change shows its text and keeps the detail rows', async () => {
  accountReply = () => jsonResponse({ statusCode: 404, message: 'Session has no WhatsApp Cloud API account' }, 404);
  await renderSessions();
  let dialog = await openDetail('cloud-ready');
  assert.ok(await rtl.within(dialog).findByText('Session has no WhatsApp Cloud API account'));
  for (const text of ['cloud-ready', CLOUD_READY.id]) assert.ok(rtl.within(dialog).getByText(text), text);
  assert.ok(dialog.querySelector('.status-badge'));

  rtl.cleanup();
  accountReply = null;
  putReply = () =>
    jsonResponse({ statusCode: 400, message: 'raw key message', code: 'META_CLOUD_NOT_CONFIGURED' }, 400);
  await renderSessions();
  dialog = await openDetail('cloud-ready');
  await rtl.within(dialog).findByText('•••• 1234');
  rtl.fireEvent.change(rtl.within(dialog).getByLabelText(en.metaCloud.account.newToken), {
    target: { value: 'another-token-0000' },
  });
  rtl.fireEvent.click(rtl.within(dialog).getByRole('button', { name: en.metaCloud.account.changeToken }));
  assert.ok(await rtl.within(dialog).findByText(en.metaCloud.errors.META_CLOUD_NOT_CONFIGURED));
  for (const text of ['cloud-ready', CLOUD_READY.id, '•••• 1234']) assert.ok(rtl.within(dialog).getByText(text), text);
});

test('C14 a NULL-engine detail requests no meta account, shows no Cloud section and keeps the toggle', async () => {
  await renderSessions();
  const dialog = await openDetail('qr-device');

  await rtl.within(dialog).findByText(en.sessions.details.autoRejectCalls);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    calls.some(c => c.path.includes('/meta/')),
    false,
  );
  assert.equal(rtl.within(dialog).queryByText(en.metaCloud.account.webhookUrl), null);
  assert.equal(rtl.within(dialog).queryByText(en.metaCloud.account.title), null);
});
