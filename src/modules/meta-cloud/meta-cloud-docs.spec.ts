import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OpenMsg (docs/32 F3): the operator's guide to a Cloud session in the dashboard lives in OPENMSG.md,
 * in Portuguese, and docs/32 records F3 as implemented.
 */
describe('Meta Cloud API dashboard docs', () => {
  const repoRoot = join(__dirname, '..', '..', '..');
  const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

  /** The `### Operar uma sessão Cloud pelo painel` section, up to the next heading of level 2 or 3. */
  const dashboardSection = (): string => {
    const doc = read('OPENMSG.md');
    const start = doc.indexOf('\n### Operar uma sessão Cloud pelo painel\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start + 1);
    const end = rest.slice(4).search(/\n#{2,3} /);
    return end === -1 ? rest : rest.slice(0, end + 4);
  };

  it('C52 OPENMSG.md has a Portuguese section on operating a Cloud session from the dashboard', () => {
    const section = dashboardSection();

    expect(section).toMatch(/Nova sessão/);
    expect(section).toMatch(/API oficial da Meta/);
    expect(section).toMatch(/\*\*Trocar o token:\*\*/);
    expect(section).toMatch(/Trocar token/);
    expect(section).toMatch(/Janela de 24 horas/);
    expect(section).toMatch(/\*\*Enviar modelo:\*\*/);
  });

  it('C52 OPENMSG.md assigns no value to META_APP_SECRET or META_CLOUD_ENCRYPTION_KEY', () => {
    const doc = read('OPENMSG.md');

    expect(doc.match(/\b(?:META_APP_SECRET|META_CLOUD_ENCRYPTION_KEY)=\S+/g)).toBeNull();
    // The detector itself: an assignment with a value is caught.
    expect('META_APP_SECRET=abc123'.match(/\b(?:META_APP_SECRET|META_CLOUD_ENCRYPTION_KEY)=\S+/g)).not.toBeNull();
  });

  it('C52 docs/32 marks F3 implemented', () => {
    const status = read('docs/32-meta-cloud-api.md')
      .split('\n')
      .slice(0, 8)
      .join(' ')
      .replace(/\s*>\s*/g, ' ');

    expect(status).toMatch(/\*\*Status:\*\*/);
    expect(status).toMatch(/F3 \(painel\) implementada/);
  });
});
