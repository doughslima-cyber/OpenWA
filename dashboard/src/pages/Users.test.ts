// Render test for the Users page under the bare `node --test` runner, on the ApiKeys.test.ts harness.
// The signed-in user is marked and cannot delete themselves; creating a user posts the form; and the
// gateway's refusal codes read as their own messages rather than the raw English text.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ana = {
  id: 'u1',
  email: 'ana@example.com',
  name: 'Ana',
  role: 'admin',
  isActive: true,
  mustChangePassword: false,
  lastLoginAt: '2026-01-02T10:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const bia = { ...ana, id: 'u2', email: 'bia@example.com', name: 'Bia', role: 'operator', lastLoginAt: undefined };

let createBody: Record<string, unknown> | undefined;
let createReply: () => Response = () => jsonResponse({ ...bia, id: 'u3' }, 201);
let patchBody: Record<string, unknown> | undefined;

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST' && path === '/api/users') {
      createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(createReply());
    }
    if (init?.method === 'PATCH' && path.startsWith('/api/users/')) {
      patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(jsonResponse(bia));
    }
    if (path === '/api/users') return Promise.resolve(jsonResponse([ana, bia]));
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Users: (typeof import('./Users.tsx'))['Users'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Users } = await import('./Users.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  createBody = undefined;
  patchBody = undefined;
  createReply = () => jsonResponse({ ...bia, id: 'u3' }, 201);
  window.sessionStorage.clear();
});

function renderUsers(): void {
  window.sessionStorage.setItem('openmsg_user', JSON.stringify(ana));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Users)),
    ),
  );
}

test('lists users, marks the signed-in one and keeps them from deleting themselves', async () => {
  renderUsers();
  await rtl.screen.findByText('bia@example.com');
  assert.ok(rtl.screen.getByText('you'));
  assert.ok(rtl.screen.getByText('Never'));
  const deleteAna = rtl.screen.getByRole('button', { name: 'Delete Ana' }) as HTMLButtonElement;
  const deleteBia = rtl.screen.getByRole('button', { name: 'Delete Bia' }) as HTMLButtonElement;
  assert.equal(deleteAna.disabled, true);
  assert.equal(deleteBia.disabled, false);
});

function openCreateAndFill(password: string): void {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Carla ' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'carla@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

test('creating a user posts the trimmed form with the default operator role', async () => {
  renderUsers();
  await rtl.screen.findByText('bia@example.com');
  openCreateAndFill('correct horse battery');
  await rtl.waitFor(() => assert.ok(createBody));
  assert.deepEqual(createBody, {
    name: 'Carla',
    email: 'carla@example.com',
    password: 'correct horse battery',
    role: 'operator',
  });
});

test('a short password is refused before reaching the gateway', async () => {
  renderUsers();
  await rtl.screen.findByText('bia@example.com');
  openCreateAndFill('short');
  assert.equal(createBody, undefined);
  assert.equal(rtl.screen.getByRole('alert').textContent, 'The password needs at least 10 characters');
});

test("the gateway's EMAIL_TAKEN code reads as its own message", async () => {
  createReply = () =>
    jsonResponse({ statusCode: 409, message: 'A user with this email already exists', code: 'EMAIL_TAKEN' }, 409);
  renderUsers();
  await rtl.screen.findByText('bia@example.com');
  openCreateAndFill('correct horse battery');
  const alert = await rtl.screen.findByRole('alert');
  assert.equal(alert.textContent, 'A user with this email already exists');
});

test('editing keeps the password unless a new one is typed, and locks the email', async () => {
  renderUsers();
  await rtl.screen.findByText('bia@example.com');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Edit Bia' }));
  assert.equal((rtl.screen.getByLabelText('Email') as HTMLInputElement).disabled, true);
  rtl.fireEvent.change(rtl.screen.getByLabelText('Role'), { target: { value: 'viewer' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save' }));
  await rtl.waitFor(() => assert.ok(patchBody));
  assert.deepEqual(patchBody, { name: 'Bia', role: 'viewer', isActive: true });
});

test('a user with a temporary password is flagged', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/api/users')
      ? Promise.resolve(jsonResponse([ana, { ...bia, mustChangePassword: true }]))
      : previous(input, init)) as typeof fetch;
  try {
    renderUsers();
    await rtl.screen.findByText('bia@example.com');
    assert.equal(rtl.screen.getAllByText('temporary password').length, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
