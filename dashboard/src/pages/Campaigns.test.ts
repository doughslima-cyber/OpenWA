// Render test for the Campaigns page under the bare `node --test` runner, on the Templates.test.ts harness.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Campaign {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'cancelled';
  counts: Record<string, number>;
  createdAt: string;
  completedAt: string | null;
}

const counts = (over: Record<string, number> = {}) => ({
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  replied: 0,
  cancelled: 0,
  ...over,
});

let campaigns: Campaign[] = [];
let createBodies: Array<Record<string, unknown>> = [];
let cancelPaths: string[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') {
      return Promise.resolve(
        jsonResponse([
          {
            id: 'sess-1',
            name: 'vendas',
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      );
    }
    if (path === '/api/sessions/sess-1/campaigns' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; recipients: string[] };
      createBodies.push(body);
      const created: Campaign = {
        id: `c-${createBodies.length}`,
        name: body.name,
        status: 'running',
        counts: counts({ total: body.recipients.length, pending: body.recipients.length }),
        createdAt: '2026-10-08T12:00:00.000Z',
        completedAt: null,
      };
      campaigns = [created, ...campaigns];
      return Promise.resolve(jsonResponse({ id: created.id, name: created.name, status: 'running', total: 2 }, 201));
    }
    if (path === '/api/sessions/sess-1/campaigns') return Promise.resolve(jsonResponse(campaigns));
    if (init?.method === 'POST' && path.endsWith('/cancel')) {
      cancelPaths.push(path);
      return Promise.resolve(jsonResponse({ id: 'c', status: 'cancelled', counts: counts() }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Campaigns: (typeof import('./Campaigns.tsx'))['Campaigns'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Campaigns } = await import('./Campaigns.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  campaigns = [];
  createBodies = [];
  cancelPaths = [];
  window.sessionStorage.clear();
});

function renderCampaigns(role: 'admin' | 'operator' | 'viewer' = 'operator'): void {
  window.sessionStorage.setItem('openwa_user_role', role);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Campaigns))),
    ),
  );
}

async function openForm(): Promise<void> {
  const button = await rtl.screen.findByRole('button', { name: 'New campaign' });
  rtl.fireEvent.click(button);
}

function fill(label: string, value: string): void {
  rtl.fireEvent.change(rtl.screen.getByLabelText(label), { target: { value } });
}

const startButton = () => rtl.screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;

test('C4 an operator fills the form, confirms the session and total, and sees the campaign running', async () => {
  renderCampaigns();
  await rtl.screen.findByText('No campaigns in this session');
  await openForm();
  fill('Name', ' Outubro ');
  fill('Numbers', '+55 (11) 98888-7777\n5511988887777\n5511977776666');
  fill('Message', 'Olá! Temos novidades.');
  rtl.fireEvent.click(startButton());

  const dialog = await rtl.screen.findByRole('dialog', { name: 'Start the campaign?' });
  assert.match(dialog.textContent ?? '', /2 numbers through the session vendas/);
  assert.equal(createBodies.length, 0);

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Start sending' }));
  await rtl.waitFor(() => assert.equal(createBodies.length, 1));
  assert.deepEqual(createBodies[0], {
    name: 'Outubro',
    text: 'Olá! Temos novidades.',
    recipients: ['5511988887777@c.us', '5511977776666@c.us'],
  });
  const row = (await rtl.screen.findByText('Outubro')).closest('tr');
  assert.ok(row);
  assert.match(row.textContent ?? '', /Running/);
});

test('C5 a .csv or .txt file loads its numbers into the recipient box', async () => {
  renderCampaigns();
  await openForm();
  const input = rtl.screen.getByLabelText('Load .csv or .txt') as HTMLInputElement;
  assert.equal(input.type, 'file');
  assert.match(input.accept, /\.csv/);
  assert.match(input.accept, /\.txt/);
  const file = new window.File(['nome;telefone\nAna;5511988887777\nBia;5511977776666\n'], 'lista.csv', {
    type: 'text/csv',
  });
  rtl.fireEvent.change(input, { target: { files: [file] } });

  await rtl.screen.findByText('Numbers accepted: 2');
  assert.match((rtl.screen.getByLabelText('Numbers') as HTMLTextAreaElement).value, /5511977776666/);
});

test('C8 Start stays disabled while no entry is a phone number', async () => {
  renderCampaigns();
  await openForm();
  fill('Name', 'Outubro');
  fill('Message', 'Olá!');
  fill('Numbers', 'abc\n12345\n120363000000000000@g.us');

  assert.ok(rtl.screen.getByText('Numbers accepted: 0'));
  assert.equal(startButton().disabled, true);

  fill('Numbers', '5511988887777');
  assert.equal(startButton().disabled, false);
});

test('C15 a viewer sees the list without New campaign or Cancel', async () => {
  campaigns = [
    {
      id: 'c-1',
      name: 'Outubro',
      status: 'running',
      counts: counts({ total: 3, pending: 3 }),
      createdAt: '2026-10-08T12:00:00.000Z',
      completedAt: null,
    },
  ];
  renderCampaigns('viewer');

  await rtl.screen.findByText('Outubro');
  assert.equal(rtl.screen.queryByRole('button', { name: 'New campaign' }), null);
  assert.equal(rtl.screen.queryByRole('button', { name: /^Cancel/ }), null);
});

test('C15 an operator sees Cancel on a running campaign', async () => {
  campaigns = [
    {
      id: 'c-1',
      name: 'Outubro',
      status: 'running',
      counts: counts({ total: 3, pending: 3 }),
      createdAt: '2026-10-08T12:00:00.000Z',
      completedAt: null,
    },
  ];
  renderCampaigns('operator');

  await rtl.screen.findByRole('button', { name: 'Cancel Outubro' });
  assert.ok(rtl.screen.getByRole('button', { name: 'New campaign' }));
});
