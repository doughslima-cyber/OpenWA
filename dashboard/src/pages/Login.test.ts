// Login page under the bare `node --test` runner, on the jsdom harness the other page tests use. The
// form signs in with email and password through POST /auth/login and hands the minted key up; bad
// credentials, a lockout and a gateway that is down each read as their own message; and the form's
// alignment must follow the document direction set on <html>.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

let sent: { url: string; body: unknown } | null = null;
let reply: () => Response = okReply;

const USER = { id: 'u1', email: 'ana@example.com', name: 'Ana', role: 'admin', isActive: true, createdAt: '' };

function okReply(): Response {
  return new Response(
    JSON.stringify({
      apiKey: 'owa_k1_minted',
      expiresAt: '',
      role: 'admin',
      engineType: 'baileys',
      scoped: false,
      user: USER,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent = { url: String(input), body: JSON.parse(String(init?.body ?? 'null')) as unknown };
    return Promise.resolve(reply());
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Login: (typeof import('./Login.tsx'))['Login'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-01-01T00:00:00.000Z';
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Login } = await import('./Login.tsx'));
});

afterEach(() => {
  sent = null;
  reply = okReply;
  sessionStorage.clear();
  rtl.cleanup();
});

function fill(email: string, password: string): void {
  const { screen, fireEvent } = rtl;
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

test('signs in with the trimmed email and hands up the minted key, role and engine', async () => {
  const logins: unknown[][] = [];
  rtl.render(createElement(Login, { onLogin: (...args: unknown[]) => logins.push(args) }));

  fill('  ana@example.com ', 'correct horse battery');

  await rtl.waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins[0], ['owa_k1_minted', 'admin', 'baileys', false]);
  assert.ok((sent?.url ?? '').endsWith('/api/auth/login'));
  assert.deepEqual(sent?.body, { email: 'ana@example.com', password: 'correct horse battery' });
  assert.equal(JSON.parse(sessionStorage.getItem('openmsg_user') ?? '{}').email, 'ana@example.com');
});

test('an empty field never reaches the gateway', () => {
  rtl.render(createElement(Login, { onLogin: () => assert.fail('signed in without credentials') }));
  fill('ana@example.com', '');
  assert.equal(sent, null);
  assert.equal(document.querySelector('.error-message')?.textContent, 'Enter your email and password');
});

async function submitAndReadError(): Promise<string> {
  rtl.render(createElement(Login, { onLogin: () => assert.fail('refused credentials signed in') }));
  fill('ana@example.com', 'wrong password');
  return rtl.waitFor(() => {
    const el = document.querySelector('.error-message');
    assert.ok(el);
    return el.textContent ?? '';
  });
}

test('a 401 reads as invalid credentials', async () => {
  reply = () =>
    new Response(JSON.stringify({ statusCode: 401, message: 'Invalid email or password' }), { status: 401 });
  assert.equal(await submitAndReadError(), 'Invalid email or password');
});

test('a 429 reads as too many attempts', async () => {
  reply = () => new Response(JSON.stringify({ statusCode: 429 }), { status: 429 });
  assert.equal(await submitAndReadError(), 'Too many attempts. Wait a few minutes and try again.');
});

test('a proxy error page while the gateway is down is a connection error, not bad credentials', async () => {
  reply = () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a network failure is a connection error', async () => {
  reply = () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a temporary password asks for a password of their own and signs in with it', async () => {
  const bodies: unknown[] = [];
  const logins: unknown[][] = [];
  reply = () => {
    bodies.push(sent?.body);
    return bodies.length === 1
      ? new Response(JSON.stringify({ passwordChangeRequired: true }), { status: 200 })
      : okReply();
  };
  rtl.render(createElement(Login, { onLogin: (...args: unknown[]) => logins.push(args) }));
  fill('ana@example.com', 'temporary pw');

  const { screen, fireEvent } = rtl;
  const next = await screen.findByLabelText('New password');
  assert.ok(screen.getByText('Your password is temporary. Choose your own password to continue.'));

  fireEvent.change(next, { target: { value: 'my own password' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'something else' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
  assert.equal(document.querySelector('.error-message')?.textContent, 'The passwords do not match');
  assert.equal(bodies.length, 1);

  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'my own password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
  await rtl.waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(bodies[1], { email: 'ana@example.com', password: 'temporary pw', newPassword: 'my own password' });
});

test('reusing the temporary password reads as its own message', async () => {
  let calls = 0;
  reply = () =>
    ++calls === 1
      ? new Response(JSON.stringify({ passwordChangeRequired: true }), { status: 200 })
      : new Response(JSON.stringify({ statusCode: 400, code: 'SAME_PASSWORD' }), { status: 400 });
  rtl.render(createElement(Login, { onLogin: () => assert.fail('signed in with a reused password') }));
  fill('ana@example.com', 'temporary pw');
  const { screen, fireEvent } = rtl;
  fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'temporary pw' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'temporary pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
  const message = await rtl.waitFor(() => {
    const text = document.querySelector('.error-message')?.textContent;
    assert.ok(text);
    return text;
  });
  assert.equal(message, 'The new password must be different from the current one');
});

test('the login form aligns to the document direction, which is set on <html>', () => {
  const css = readFileSync(fileURLToPath(new URL('./Login.css', import.meta.url)), 'utf8');
  // i18n sets `dir` on the document element only, so a `[dir]` compound after another selector part
  // would need a second element carrying `dir` inside the page and never matches.
  assert.deepEqual(css.match(/[^\s,{}][^,{}]*\s\[dir[^\]]*\][^{]*/g) ?? [], []);
  assert.match(css, /\.login-container \.login-form \{\s*text-align: start;\s*\}/);
});
