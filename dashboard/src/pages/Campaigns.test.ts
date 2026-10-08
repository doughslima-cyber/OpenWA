// Render test for the Campaigns page under the bare `node --test` runner, on the Templates.test.ts harness.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { QueryClient } from '@tanstack/react-query';

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

interface Recipient {
  chatId: string;
  status: string;
  sentAt: string | null;
  repliedAt: string | null;
  error: { code: string; message: string } | null;
}

interface Detail extends Campaign {
  text: string;
  waiting: { reason: 'pacing' | 'restricted' | 'disconnected'; nextAttemptAt: string | null } | null;
}

let campaigns: Campaign[] = [];
/** The second session's campaigns, to tell the selected session's list apart. */
let supportCampaigns: Campaign[] = [];
/** `GET .../campaigns/:id` answers, by id; a campaign of the list without one answers with no wait. */
let details: Record<string, Detail> = {};
/** Every recipient of each campaign, by id; the stub filters and pages them as the API does. */
let recipientRows: Record<string, Recipient[]> = {};
/** The query string of every `GET .../recipients`, in order. */
let recipientRequests: URLSearchParams[] = [];
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
          {
            id: 'sess-2',
            name: 'suporte',
            status: 'ready',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
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
    if (path === '/api/sessions/sess-2/campaigns') return Promise.resolve(jsonResponse(supportCampaigns));
    const recipientsMatch = /^\/api\/sessions\/sess-1\/campaigns\/([^/?]+)\/recipients\?(.*)$/.exec(path);
    if (recipientsMatch && !init?.method) {
      const query = new URLSearchParams(recipientsMatch[2]);
      recipientRequests.push(query);
      const status = query.get('status');
      const rows = (recipientRows[recipientsMatch[1]] ?? []).filter(row => !status || row.status === status);
      const offset = Number(query.get('offset') ?? 0);
      const limit = Number(query.get('limit') ?? 50);
      return Promise.resolve(jsonResponse({ items: rows.slice(offset, offset + limit), total: rows.length }));
    }
    const detailMatch = /^\/api\/sessions\/sess-1\/campaigns\/([^/?]+)$/.exec(path);
    if (detailMatch && !init?.method) {
      const id = detailMatch[1];
      const listed = campaigns.find(campaign => campaign.id === id);
      const detail = details[id] ?? (listed && { ...listed, text: 'Olá!', waiting: null });
      return Promise.resolve(detail ? jsonResponse(detail) : jsonResponse({ message: 'not found' }, 404));
    }
    if (init?.method === 'POST' && path.endsWith('/cancel')) {
      cancelPaths.push(path);
      return Promise.resolve(jsonResponse({ id: 'c', status: 'cancelled', counts: counts() }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Campaigns: (typeof import('./Campaigns.tsx'))['Campaigns'];
let i18n: (typeof import('../i18n/index.ts'))['default'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let reactQuery: typeof import('@tanstack/react-query');
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  // Loaded only once jsdom is in place: query-core decides at load time whether it runs on a server
  // (no `window`), and on a server it never schedules `refetchInterval`, which C40 depends on.
  reactQuery = await import('@tanstack/react-query');
  // Its timers (gcTime, refetchInterval) are then real; unref them, as App.test.ts does, so a timer
  // left by the last case never holds the test process open.
  const unref = (id: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => id.unref();
  reactQuery.timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
    clearTimeout: id => clearTimeout(id),
    setInterval: (callback, delay) => unref(setInterval(callback, delay)),
    clearInterval: id => clearInterval(id),
  });
  const i18nModule = await import('../i18n/index.ts');
  await i18nModule.i18nReady;
  i18n = i18nModule.default;
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
  supportCampaigns = [];
  details = {};
  recipientRows = {};
  recipientRequests = [];
  createBodies = [];
  cancelPaths = [];
  window.sessionStorage.clear();
});

function renderCampaigns(role: 'admin' | 'operator' | 'viewer' = 'operator'): void {
  window.sessionStorage.setItem('openwa_user_role', role);
  queryClient = new reactQuery.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      reactQuery.QueryClientProvider,
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

const loadInput = () => rtl.screen.getByLabelText('Load .csv, .txt or .xlsx') as HTMLInputElement;

function pick(name: string, content: BlobPart, type: string): void {
  rtl.fireEvent.change(loadInput(), { target: { files: [new window.File([content], name, { type })] } });
}

test('C5 a .csv or .txt file loads its numbers into the recipient box', async () => {
  renderCampaigns();
  await openForm();
  const input = loadInput();
  assert.equal(input.type, 'file');
  assert.match(input.accept, /\.csv/);
  assert.match(input.accept, /\.txt/);
  assert.match(input.accept, /\.xlsx/);

  // A one-column .txt goes straight into the box.
  pick('lista.txt', '5511988887777\n5511977776666\n', 'text/plain');
  await rtl.screen.findByText('Numbers accepted: 2');

  // A .csv with several columns waits for the operator to confirm which one holds the phone.
  pick('lista.csv', 'nome;telefone\nAna;5511966665555\nBia;5511955554444\n', 'text/csv');
  await rtl.screen.findByRole('region', { name: 'Choose the phone column in' });
  assert.equal(rtl.screen.getByText('Numbers accepted: 2').textContent, 'Numbers accepted: 2');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Use this column (2 entries)' }));
  await rtl.screen.findByText('Numbers accepted: 4');
  assert.match((rtl.screen.getByLabelText('Numbers') as HTMLTextAreaElement).value, /5511955554444/);
});

test('a CSV with a CPF column takes only the phone column the operator confirms', async () => {
  renderCampaigns();
  await openForm();
  pick(
    'clientes.csv',
    'Nome,CPF,Celular,CEP\n"Silva, Ana",12345678909,+55 11 98888-7777,01310100\nBia,98765432100,+55 11 97777-6666,04538133\n',
    'text/csv',
  );

  const column = (await rtl.screen.findByLabelText('Phone column')) as HTMLSelectElement;
  assert.equal(column.value, '2');
  assert.equal(column.selectedOptions[0].textContent, 'C — Celular');
  assert.equal((rtl.screen.getByLabelText('First row is a header') as HTMLInputElement).checked, true);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Use this column (2 entries)' }));

  await rtl.screen.findByText('Numbers accepted: 2');
  const box = (rtl.screen.getByLabelText('Numbers') as HTMLTextAreaElement).value;
  assert.doesNotMatch(box, /12345678909|98765432100|01310100/);
});

test('the operator can pick another column, and Discard adds nothing', async () => {
  renderCampaigns();
  await openForm();
  pick('a.csv', 'Nome;Fixo;Celular\nAna;1133334444;11988887777\n', 'text/csv');
  const column = (await rtl.screen.findByLabelText('Phone column')) as HTMLSelectElement;
  rtl.fireEvent.change(column, { target: { value: '1' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Use this column (1 entries)' }));
  await rtl.waitFor(() =>
    assert.equal((rtl.screen.getByLabelText('Numbers') as HTMLTextAreaElement).value, '1133334444'),
  );

  pick('b.csv', 'Nome;Celular\nBia;11977776666\n', 'text/csv');
  await rtl.screen.findByLabelText('Phone column');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Discard' }));
  assert.equal(rtl.screen.queryByLabelText('Phone column'), null);
  assert.equal((rtl.screen.getByLabelText('Numbers') as HTMLTextAreaElement).value, '1133334444');
});

test('an .xlsx file loads its first sheet through the column picker', async () => {
  const { buildXlsx } = await import('../test-helpers/xlsx-fixture.ts');
  renderCampaigns();
  await openForm();
  const bytes = buildXlsx([
    ['Cliente', 'WhatsApp'],
    ['Ana', { n: '5511988887777' }],
    ['Bia', { n: '5511977776666' }],
  ]);
  pick('lista.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const column = (await rtl.screen.findByLabelText('Phone column')) as HTMLSelectElement;
  assert.equal(column.selectedOptions[0].textContent, 'B — WhatsApp');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Use this column (2 entries)' }));
  await rtl.screen.findByText('Numbers accepted: 2');
});

test('an old .xls file is refused with a message', async () => {
  renderCampaigns();
  await openForm();
  pick('lista.xls', 'binary', 'application/vnd.ms-excel');
  const alert = await rtl.screen.findByRole('alert');
  assert.equal(alert.textContent, 'Old .xls files are not supported; save the sheet as .xlsx or .csv');
});

test('55 is added to national numbers by default, and not once the operator turns it off', async () => {
  renderCampaigns();
  await openForm();
  fill('Name', 'Outubro');
  fill('Message', 'Olá!');
  fill('Numbers', '(11) 98888-7777\n5511977776666');
  const option = rtl.screen.getByLabelText(
    'Add 55 (Brazil) to numbers written without a country code',
  ) as HTMLInputElement;
  assert.equal(option.checked, true);
  assert.ok(rtl.screen.getByText('Numbers that got the 55: 1'));

  rtl.fireEvent.click(startButton());
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Start sending' }));
  await rtl.waitFor(() => assert.equal(createBodies.length, 1));
  assert.deepEqual(createBodies[0].recipients, ['5511988887777@c.us', '5511977776666@c.us']);

  await openForm();
  fill('Name', 'Novembro');
  fill('Message', 'Olá!');
  fill('Numbers', '(11) 98888-7777');
  rtl.fireEvent.click(rtl.screen.getByLabelText('Add 55 (Brazil) to numbers written without a country code'));
  assert.equal(rtl.screen.queryByText(/Numbers that got the 55/), null);
  rtl.fireEvent.click(startButton());
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Start sending' }));
  await rtl.waitFor(() => assert.equal(createBodies.length, 2));
  assert.deepEqual(createBodies[1].recipients, ['11988887777@c.us']);
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

const campaign = (over: Partial<Campaign> & Pick<Campaign, 'id' | 'name'>): Campaign => ({
  status: 'running',
  counts: counts({ total: 3, pending: 3 }),
  createdAt: '2026-10-08T12:00:00.000Z',
  completedAt: null,
  ...over,
});

/** Run `fn` with the dashboard in Portuguese, back to English afterwards whatever happens. */
async function inPortuguese(fn: () => Promise<void>): Promise<void> {
  await i18n.changeLanguage('pt-BR');
  try {
    await fn();
  } finally {
    rtl.cleanup();
    await i18n.changeLanguage('en');
  }
}

/** Open a campaign from the list by its name. */
async function openCampaign(name: string): Promise<void> {
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name }));
}

const cellsOf = (row: Element): string[] => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? '');

const counter = (status: string) => rtl.screen.getByTestId(`campaign-count-${status}`);

test('C36 the list shows the selected session campaigns newest first with name, status, sent/total, failed, replied and creation date', async () => {
  campaigns = [
    campaign({
      id: 'c-a',
      name: 'Setembro',
      status: 'completed',
      counts: counts({ total: 10, sent: 3, replied: 2, failed: 4, cancelled: 1 }),
      createdAt: '2026-09-15T09:30:00.000Z',
    }),
    campaign({
      id: 'c-b',
      name: 'Outubro',
      counts: counts({ total: 20, pending: 12, sent: 5, replied: 1, failed: 2 }),
      createdAt: '2026-10-08T12:00:00.000Z',
    }),
    campaign({
      id: 'c-c',
      name: 'Início de outubro',
      status: 'cancelled',
      counts: counts({ total: 4, sent: 1, cancelled: 3 }),
      createdAt: '2026-10-01T08:00:00.000Z',
    }),
  ];
  supportCampaigns = [campaign({ id: 'c-s', name: 'Suporte', createdAt: '2026-10-05T10:00:00.000Z' })];
  renderCampaigns('viewer');

  await rtl.screen.findByText('Outubro');
  const rows = [...document.querySelectorAll('.campaigns-table tbody tr')].map(cellsOf);
  const date = (iso: string) => new Date(iso).toLocaleString('en');
  assert.deepEqual(rows, [
    ['Outubro', 'Running', '6/20', '2', '1', date('2026-10-08T12:00:00.000Z')],
    ['Início de outubro', 'Cancelled', '1/4', '0', '0', date('2026-10-01T08:00:00.000Z')],
    ['Setembro', 'Completed', '5/10', '4', '2', date('2026-09-15T09:30:00.000Z')],
  ]);
  const headers = [...document.querySelectorAll('.campaigns-table thead th')].map(th => th.textContent);
  assert.deepEqual(headers, ['Name', 'Status', 'Sent', 'Failed', 'Replied', 'Created']);

  // Another session: only its campaigns.
  rtl.fireEvent.change(rtl.screen.getByLabelText('Session'), { target: { value: 'sess-2' } });
  await rtl.screen.findByText('Suporte');
  assert.equal(rtl.screen.queryByText('Outubro'), null);
  assert.equal(document.querySelectorAll('.campaigns-table tbody tr').length, 1);
});

test('C37 a session with no campaigns shows "Nenhuma campanha nesta sessão" and, for operator and admin, Nova campanha', async () => {
  await inPortuguese(async () => {
    for (const role of ['operator', 'admin'] as const) {
      renderCampaigns(role);
      await rtl.screen.findByText('Nenhuma campanha nesta sessão');
      assert.ok(await rtl.screen.findByRole('button', { name: 'Nova campanha' }), `${role} sees Nova campanha`);
      rtl.cleanup();
      queryClient?.clear();
    }
  });
});

test('C39 the campaign screen shows counters by status and the recipient table, filtered and paged by status, limit and offset', async () => {
  const rowsFor = (i: number): Recipient => {
    const chatId = `55119000${String(i).padStart(5, '0')}@c.us`;
    if (i === 0) {
      return {
        chatId,
        status: 'replied',
        sentAt: '2026-10-08T12:00:00.000Z',
        repliedAt: '2026-10-08T12:30:00.000Z',
        error: null,
      };
    }
    if (i % 10 === 1) {
      return { chatId, status: 'failed', sentAt: null, repliedAt: null, error: { code: 'SEND_FAILED', message: 'x' } };
    }
    if (i < 60) return { chatId, status: 'sent', sentAt: '2026-10-08T12:01:00.000Z', repliedAt: null, error: null };
    return { chatId, status: 'pending', sentAt: null, repliedAt: null, error: null };
  };
  recipientRows = { 'c-1': Array.from({ length: 120 }, (_, i) => rowsFor(i)) };
  campaigns = [
    campaign({
      id: 'c-1',
      name: 'Outubro',
      status: 'completed',
      counts: counts({ total: 120, pending: 54, sending: 1, sent: 52, failed: 12, replied: 1 }),
    }),
  ];
  renderCampaigns('viewer');
  await openCampaign('Outubro');

  await rtl.screen.findByRole('heading', { name: 'Outubro' });
  const expected: Record<string, [string, string]> = {
    total: ['Total', '120'],
    pending: ['Pending', '54'],
    sending: ['Sending', '1'],
    sent: ['Sent', '52'],
    failed: ['Failed', '12'],
    replied: ['Replied', '1'],
    cancelled: ['Cancelled', '0'],
  };
  for (const [status, [label, value]] of Object.entries(expected)) {
    const dd = counter(status);
    assert.equal(dd.textContent, value, `${status} counter`);
    assert.equal(dd.previousElementSibling?.textContent, label, `${status} label`);
  }

  // First page: no status, the API's page size, from the start.
  await rtl.screen.findByText('5511900000000');
  let last = recipientRequests.at(-1)!;
  assert.equal(last.get('status'), null);
  assert.equal(last.get('limit'), '50');
  assert.equal(last.get('offset'), '0');
  const headers = [...document.querySelectorAll('.campaigns-detail .campaigns-table thead th')].map(
    th => th.textContent,
  );
  assert.deepEqual(headers, ['Number', 'Status', 'Sent at', 'Replied at', 'Error code']);
  const date = (iso: string) => new Date(iso).toLocaleString('en');
  const tableRows = () => [...document.querySelectorAll('.campaigns-detail .campaigns-table tbody tr')];
  assert.equal(tableRows().length, 50);
  assert.deepEqual(cellsOf(tableRows()[0]), [
    '5511900000000',
    'Replied',
    date('2026-10-08T12:00:00.000Z'),
    date('2026-10-08T12:30:00.000Z'),
    '-',
  ]);
  assert.deepEqual(cellsOf(tableRows()[1]), ['5511900000001', 'Failed', '-', '-', 'SEND_FAILED']);
  assert.ok(rtl.screen.getByText('1–50 of 120'));

  // Next and previous move the offset by one page.
  const next = () => rtl.screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  const previous = () => rtl.screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
  assert.equal(previous().disabled, true);
  rtl.fireEvent.click(next());
  await rtl.screen.findByText('5511900000050');
  last = recipientRequests.at(-1)!;
  assert.equal(last.get('offset'), '50');
  assert.equal(last.get('limit'), '50');
  assert.ok(rtl.screen.getByText('51–100 of 120'));
  rtl.fireEvent.click(next());
  await rtl.screen.findByText('5511900000100');
  assert.equal(recipientRequests.at(-1)!.get('offset'), '100');
  assert.ok(rtl.screen.getByText('101–120 of 120'));
  assert.equal(next().disabled, true);
  rtl.fireEvent.click(previous());
  await rtl.screen.findByText('5511900000050');
  assert.equal(recipientRequests.at(-1)!.get('offset'), '50');

  // The status filter asks the API for that status, from the first page again.
  rtl.fireEvent.change(rtl.screen.getByLabelText('Filter by status'), { target: { value: 'failed' } });
  await rtl.waitFor(() => assert.equal(recipientRequests.at(-1)!.get('status'), 'failed'));
  last = recipientRequests.at(-1)!;
  assert.equal(last.get('limit'), '50');
  assert.equal(last.get('offset'), '0');
  await rtl.waitFor(() => assert.equal(tableRows().length, 12));
  assert.ok(tableRows().every(row => cellsOf(row)[1] === 'Failed'));
  assert.ok(rtl.screen.getByText('1–12 of 12'));
});

test('C40 while the open campaign runs, a counter change reaches the screen within 10 s with no reload', async () => {
  campaigns = [campaign({ id: 'c-1', name: 'Outubro', counts: counts({ total: 3, pending: 2, sent: 1 }) })];
  details['c-1'] = { ...campaigns[0], text: 'Olá!', waiting: null };
  recipientRows = { 'c-1': [] };
  renderCampaigns('viewer');
  await openCampaign('Outubro');
  await rtl.waitFor(() => assert.equal(counter('sent').textContent, '1'));
  const sentCell = counter('sent');

  // The runner sends one more; nothing on the page is touched.
  details['c-1'] = { ...details['c-1'], counts: counts({ total: 3, pending: 1, sent: 2 }) };
  const changedAt = Date.now();
  await rtl.waitFor(() => assert.equal(counter('sent').textContent, '2'), { timeout: 10_000, interval: 100 });

  assert.ok(Date.now() - changedAt <= 10_000);
  assert.equal(counter('pending').textContent, '1');
  // Same element, updated in place: the screen was not reloaded or remounted.
  assert.equal(counter('sent'), sentCell);
  assert.ok(sentCell.isConnected);
});

test('C42 the campaign screen shows the wait reason in pt-BR for pacing, restricted and disconnected', async () => {
  const nextAttemptAt = '2026-10-09T00:00:00.000Z';
  const local = new Date(nextAttemptAt);
  const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  const cases: Array<[Detail['waiting'], string]> = [
    [{ reason: 'pacing', nextAttemptAt }, `Aguardando a cota de envio (próxima tentativa às ${hhmm})`],
    [{ reason: 'restricted', nextAttemptAt: null }, 'A sessão está com restrição do WhatsApp'],
    [{ reason: 'disconnected', nextAttemptAt: null }, 'A sessão não está conectada'],
  ];
  await inPortuguese(async () => {
    for (const [waiting, text] of cases) {
      campaigns = [campaign({ id: 'c-1', name: 'Outubro' })];
      details['c-1'] = { ...campaigns[0], text: 'Olá!', waiting };
      renderCampaigns('viewer');
      await openCampaign('Outubro');
      const status = await rtl.screen.findByRole('status');
      assert.equal(status.textContent, text);
      rtl.cleanup();
      queryClient?.clear();
    }

    // A running campaign that is sending shows no reason.
    details['c-1'] = { ...campaigns[0], text: 'Olá!', waiting: null };
    renderCampaigns('viewer');
    await openCampaign('Outubro');
    await rtl.screen.findByRole('heading', { name: 'Outubro' });
    assert.equal(rtl.screen.queryByRole('status'), null);
  });
});

test('C44 Cancel in the list opens a confirmation; refusing posts nothing, confirming posts .../cancel', async () => {
  campaigns = [campaign({ id: 'c-1', name: 'Outubro' })];
  renderCampaigns('operator');

  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Cancel Outubro' }));
  await rtl.screen.findByRole('dialog', { name: 'Cancel the campaign?' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Keep running' }));
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('dialog'), null));
  assert.deepEqual(cancelPaths, []);

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Cancel Outubro' }));
  await rtl.screen.findByRole('dialog', { name: 'Cancel the campaign?' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Cancel campaign' }));
  await rtl.waitFor(() => assert.deepEqual(cancelPaths, ['/api/sessions/sess-1/campaigns/c-1/cancel']));
});

test('C44 Cancel on the campaign screen opens a confirmation; refusing posts nothing, confirming posts .../cancel', async () => {
  campaigns = [campaign({ id: 'c-1', name: 'Outubro' })];
  recipientRows = { 'c-1': [] };
  renderCampaigns('operator');
  await openCampaign('Outubro');
  await rtl.screen.findByRole('heading', { name: 'Outubro' });

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Cancel Outubro' }));
  await rtl.screen.findByRole('dialog', { name: 'Cancel the campaign?' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Keep running' }));
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('dialog'), null));
  assert.deepEqual(cancelPaths, []);

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Cancel Outubro' }));
  await rtl.screen.findByRole('dialog', { name: 'Cancel the campaign?' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Cancel campaign' }));
  await rtl.waitFor(() => assert.deepEqual(cancelPaths, ['/api/sessions/sess-1/campaigns/c-1/cancel']));
  // Still on the campaign screen.
  assert.ok(rtl.screen.getByRole('heading', { name: 'Outubro' }));
});
