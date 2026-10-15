// The sidebar theme button cycles light, dark and "follow the system". The choice is stored, so a button
// that only flipped light and dark lost "System" for good after the first click.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let Layout: (typeof import('./Layout.tsx'))['Layout'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let Routes: (typeof import('react-router-dom'))['Routes'];
let Route: (typeof import('react-router-dom'))['Route'];
let Link: (typeof import('react-router-dom'))['Link'];
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
// Every URL the layout asked for.
const requested: string[] = [];

/** The layout for an admin key, restricted to selected sessions when `scoped` is set. */
function renderLayout(scoped = false, initialEntry = '/'): ReturnType<typeof import('@testing-library/react').render> {
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'whatsapp-web.js',
    setEngineType: () => undefined,
    scoped,
    setScoped: () => undefined,
  };
  return rtl.render(
    createElement(
      RoleContext.Provider,
      { value: role },
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(Layout, { onLogout: () => undefined, userRole: 'admin' }) },
            // A page body that links into the Messages group, so a test can move there from outside the sidebar.
            createElement(Route, { path: '*', element: createElement(Link, { to: '/templates' }, 'Open templates') }),
          ),
        ),
      ),
    ),
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  // jsdom has no matchMedia; the theme hook reads it for the system preference.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requested.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ message: 'unstubbed' }), { status: 404 }));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter, Routes, Route, Link } = await import('react-router-dom'));
  ({ Layout } = await import('./Layout.tsx'));
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  requested.length = 0;
});

after(() => rtl.cleanup());

test('the theme button can return to following the system', () => {
  localStorage.removeItem('openwa_theme');
  const { container } = renderLayout();
  const button = container.querySelector<HTMLButtonElement>('.appearance-menu .theme-toggle-btn')!;
  const seen = [button.textContent];
  for (let i = 0; i < 3; i++) {
    const announced = button.getAttribute('aria-label');
    rtl.fireEvent.click(button);
    seen.push(button.textContent);
    // The label names the state the click selects.
    assert.equal(announced, `Switch to ${button.textContent}`);
  }
  assert.deepEqual(seen, ['System', 'Light', 'Dark', 'System']);
  assert.equal(localStorage.getItem('openwa_theme'), 'system');
});

// The key management, infrastructure and plugin routes refuse a key restricted to selected sessions, whatever
// its role, and every refusal lands in the audit log as a failed attempt.
test('an admin key scoped to sessions is not offered the pages that refuse it', async () => {
  renderLayout(true);
  const { screen } = rtl;
  rtl.fireEvent.click(screen.getByRole('button', { name: 'Administration' }));
  assert.equal(screen.queryByRole('link', { name: 'API Keys' }) === null, true);
  assert.equal(screen.queryByRole('link', { name: 'Infrastructure' }) === null, true);
  assert.equal(screen.queryByRole('link', { name: 'Plugins' }) === null, true);
  // The audit read is filtered to the key's sessions, not refused.
  assert.ok(screen.getByRole('link', { name: 'Logs' }));
  await rtl.waitFor(() => assert.ok(requested.some(url => url.includes('/health'))));
  assert.equal(
    requested.some(url => url.includes('/infra/update-check')),
    false,
  );
});

test('an unscoped admin key still checks for a newer release', async () => {
  renderLayout();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Administration' }));
  assert.ok(rtl.screen.getByRole('link', { name: 'Plugins' }));
  await rtl.waitFor(() => assert.ok(requested.some(url => url.includes('/infra/update-check'))));
});

test('the sidebar groups navigation and keeps administration collapsed until it is needed', () => {
  renderLayout();
  const { screen } = rtl;
  assert.equal(screen.getByRole('button', { name: 'Operation' }).getAttribute('aria-expanded'), 'true');
  assert.equal(screen.getByRole('button', { name: 'Messages' }).getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('link', { name: 'Sessions' }));
  assert.ok(screen.getByRole('link', { name: 'Templates' }));
  // Each toggle sits in a heading, so heading navigation still reaches the groups.
  assert.deepEqual(
    screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent),
    ['Operation', 'Messages', 'Administration'],
  );

  const administration = screen.getByRole('button', { name: 'Administration' });
  assert.equal(administration.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByRole('link', { name: 'API Keys' }), null);

  rtl.fireEvent.click(administration);
  assert.equal(administration.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('link', { name: 'API Keys' }));
  assert.equal(screen.getByRole('link', { name: 'My account' }).closest('.sidebar-footer') === null, false);
});

for (const { section, other, link } of [
  { section: 'Operation', other: 'Messages', link: 'Sessions' },
  { section: 'Messages', other: 'Operation', link: 'Templates' },
]) {
  test(`the ${section} group folds and unfolds on its own`, () => {
    const { container } = renderLayout(false, '/account');
    const { screen } = rtl;
    const toggle = screen.getByRole('button', { name: section });
    const panel = container.querySelector<HTMLElement>(`#${toggle.getAttribute('aria-controls')}`)!;
    assert.ok(panel.contains(screen.getByRole('link', { name: link })));

    rtl.fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(panel.hidden, true);
    assert.equal(screen.queryByRole('link', { name: link }), null);
    // The other groups keep their own state.
    assert.equal(screen.getByRole('button', { name: other }).getAttribute('aria-expanded'), 'true');
    assert.equal(screen.getByRole('button', { name: 'Administration' }).getAttribute('aria-expanded'), 'false');

    rtl.fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);
    assert.ok(screen.getByRole('link', { name: link }));
  });
}

test('a folded group unfolds when the route moves inside it', () => {
  renderLayout(false, '/account');
  const { screen } = rtl;
  const operation = screen.getByRole('button', { name: 'Operation' });
  const messages = screen.getByRole('button', { name: 'Messages' });
  rtl.fireEvent.click(operation);
  rtl.fireEvent.click(messages);
  assert.equal(messages.getAttribute('aria-expanded'), 'false');

  rtl.fireEvent.click(screen.getByRole('link', { name: 'Open templates' }));
  assert.equal(messages.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('link', { name: 'Templates' }));
  // Only the group holding the route opens.
  assert.equal(operation.getAttribute('aria-expanded'), 'false');
});

// A heading is named from its content, not from its button's title, so the icons-only sidebar still has to
// carry the group name as (visually hidden) text.
test('the group headings and toggles keep their names in the icons-only sidebar', () => {
  const { container } = renderLayout(false, '/account');
  const { screen } = rtl;
  rtl.fireEvent.click(container.querySelector<HTMLButtonElement>('.collapse-toggle')!);
  assert.ok(container.querySelector('.sidebar.collapsed'));
  for (const name of ['Operation', 'Messages', 'Administration']) {
    assert.ok(screen.getByRole('heading', { level: 2, name }));
    assert.ok(screen.getByRole('button', { name }));
  }
});

test('the administration group opens for an active administration route', () => {
  renderLayout(false, '/users');
  const { screen } = rtl;
  assert.equal(screen.getByRole('button', { name: 'Administration' }).getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('link', { name: 'Users' }));
});
