// Render tests for the Campaigns page with a WhatsApp Cloud API session (OpenMsg, docs/32 F3), on the
// Campaigns.test.ts harness. Cloud API campaigns arrive with templates (doc 32 F4): until then the page
// offers no New campaign on a Cloud session, and the gateway's refusal reads as its own text.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { QueryClient } from '@tanstack/react-query';

const en = JSON.parse(readFileSync(new URL('../i18n/locales/en.json', import.meta.url), 'utf8')) as {
  campaigns: { newBtn: string; sessionSelect: string; errors: Record<string, string>; form: Record<string, string> };
  metaCloud: { campaignsNote: string };
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const base = { status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const CLOUD = { ...base, id: 'sess-cloud', name: 'oficial', engine: 'meta-cloud' };
const QR = { ...base, id: 'sess-qr', name: 'vendas' };

let sessions: unknown[] = [];
const createReply = (): Response =>
  jsonResponse(
    { statusCode: 400, message: 'raw campaign refusal', code: 'CAMPAIGN_ENGINE_UNSUPPORTED', error: 'Bad Request' },
    400,
  );

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') return Promise.resolve(jsonResponse(sessions));
    if (/^\/api\/sessions\/[^/]+\/campaigns$/.test(path) && init?.method === 'POST') {
      return Promise.resolve(createReply());
    }
    if (/^\/api\/sessions\/[^/]+\/campaigns$/.test(path)) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Campaigns: (typeof import('./Campaigns.tsx'))['Campaigns'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let reactQuery: typeof import('@tanstack/react-query');
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  reactQuery = await import('@tanstack/react-query');
  const unref = (id: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => id.unref();
  reactQuery.timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
    clearTimeout: id => clearTimeout(id),
    setInterval: (callback, delay) => unref(setInterval(callback, delay)),
    clearInterval: id => clearInterval(id),
  });
  const i18nModule = await import('../i18n/index.ts');
  await i18nModule.i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Campaigns } = await import('./Campaigns.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  window.sessionStorage.clear();
});

function renderCampaigns(): void {
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  queryClient = new reactQuery.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      reactQuery.QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Campaigns))),
    ),
  );
}

const newButton = () => rtl.screen.queryByRole('button', { name: en.campaigns.newBtn });

test('C42 a Cloud session hides New campaign and shows the note; a NULL-engine session shows the button', async () => {
  sessions = [CLOUD, QR];
  renderCampaigns();

  assert.ok(await rtl.screen.findByText(en.metaCloud.campaignsNote));
  assert.equal(newButton() === null, true);

  rtl.fireEvent.change(rtl.screen.getByLabelText(en.campaigns.sessionSelect), { target: { value: QR.id } });
  await rtl.waitFor(() => assert.equal(newButton() !== null, true));
  assert.equal(rtl.screen.queryByText(en.metaCloud.campaignsNote) === null, true);
});

test('C43 a campaign request refused with CAMPAIGN_ENGINE_UNSUPPORTED shows its catalog text', async () => {
  sessions = [QR];
  renderCampaigns();

  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: en.campaigns.newBtn }));
  const fill = (label: string, value: string) =>
    rtl.fireEvent.change(rtl.screen.getByLabelText(label), { target: { value } });
  fill(en.campaigns.form.name, 'Outubro');
  fill(en.campaigns.form.recipients, '5511988887777');
  fill(en.campaigns.form.text, 'Olá!');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: en.campaigns.form.start }));
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Start sending' }));

  const shown = await rtl.screen.findAllByText(en.campaigns.errors.CAMPAIGN_ENGINE_UNSUPPORTED);
  assert.ok(shown.length > 0);
  assert.equal(rtl.screen.queryByText('raw campaign refusal') === null, true);
});
