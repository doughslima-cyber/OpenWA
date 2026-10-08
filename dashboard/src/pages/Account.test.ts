// Render test for the account page under the bare `node --test` runner. It shows the signed-in
// user's profile, checks the new password locally, and maps the gateway's refusal codes to messages.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let sent: { path: string; key: string | null; body: unknown }[] = [];
let reply: () => Response = () => new Response(null, { status: 204 });

let rtl: typeof import('@testing-library/react');
let Account: (typeof import('./Account.tsx'))['Account'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      path: url.replace(/^https?:\/\/[^/]+/, ''),
      key: new Headers(init?.headers).get('X-API-Key'),
      body: JSON.parse(String(init?.body ?? 'null')) as unknown,
    });
    return Promise.resolve(reply());
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Account } = await import('./Account.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  sent = [];
  reply = () => new Response(null, { status: 204 });
  window.sessionStorage.clear();
});

function renderAccount(): void {
  window.sessionStorage.setItem('openwa_api_key', 'owa_k1_session');
  window.sessionStorage.setItem(
    'openmsg_user',
    JSON.stringify({ id: 'u1', email: 'ana@example.com', name: 'Ana', role: 'operator', isActive: true }),
  );
  rtl.render(createElement(ToastProvider, null, createElement(Account)));
}

function submit(current: string, next: string, confirm: string): void {
  const { screen, fireEvent } = rtl;
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

test('shows the signed-in profile', () => {
  renderAccount();
  assert.ok(rtl.screen.getByText('ana@example.com'));
  assert.ok(rtl.screen.getByText('Ana'));
  assert.ok(rtl.screen.getByText('Operator'));
});

test('checks length and confirmation before calling the gateway', () => {
  renderAccount();
  submit('old password', 'short', 'short');
  assert.equal(rtl.screen.getByRole('alert').textContent, 'The password needs at least 10 characters');
  submit('old password', 'a long new password', 'a different one!!');
  assert.equal(rtl.screen.getByRole('alert').textContent, 'The passwords do not match');
  assert.equal(sent.length, 0);
});

test('posts the change with the session key and clears the form', async () => {
  renderAccount();
  submit('old password', 'a long new password', 'a long new password');
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(sent[0], {
    path: '/api/auth/me/password',
    key: 'owa_k1_session',
    body: { currentPassword: 'old password', newPassword: 'a long new password' },
  });
  await rtl.waitFor(() => assert.equal((rtl.screen.getByLabelText('Current password') as HTMLInputElement).value, ''));
});

test('a wrong current password reads as its own message and keeps the session', async () => {
  reply = () =>
    jsonResponse({ statusCode: 400, message: 'The current password is wrong', code: 'WRONG_PASSWORD' }, 400);
  renderAccount();
  submit('wrong password', 'a long new password', 'a long new password');
  const alert = await rtl.screen.findByRole('alert');
  assert.equal(alert.textContent, 'The current password is wrong');
  assert.equal(window.sessionStorage.getItem('openwa_api_key'), 'owa_k1_session');
});
