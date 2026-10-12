import type { Repository } from 'typeorm';
import type { MetaCloudAccountStore } from '../../engine/adapters/meta-cloud-account-store.service';
import { MetaGraphClient } from '../../engine/adapters/meta-cloud-graph.client';
import { FakeGraph, RecordedGraphRequest, startFakeGraph } from '../../engine/adapters/__fixtures__/fake-graph-server';
import type { Session } from '../session/entities/session.entity';
import { MetaCloudTemplatesService } from './meta-cloud-templates.service';

const WABA_ID = '102290129340398';
const TOKEN = 'EAAGm0PX4ZCpsBAJ7ZBZCkQZDZD-templates-spec-token';

/** A Graph template as `GET /<WABA_ID>/message_templates` lists it. */
function graphTemplate(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `template_${String(n).padStart(3, '0')}`,
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    parameter_format: 'POSITIONAL',
    components: [{ type: 'BODY', text: `Body ${n} {{1}}`, example: { body_text: [['x']] } }],
    id: `${900000 + n}`,
    ...extra,
  };
}

/** `count` templates cut into pages of `size`, each page but the last pointing at the next through `after`. */
function pagedScript(count: number, size: number) {
  const all = Array.from({ length: count }, (_, i) => graphTemplate(i + 1));
  return (request: RecordedGraphRequest) => {
    const url = new URL(request.path, 'http://graph.local');
    const after = url.searchParams.get('after');
    const start = after ? Number(after.replace('cursor-', '')) : 0;
    const data = all.slice(start, start + size);
    const end = start + data.length;
    const more = end < all.length;
    return {
      status: 200,
      body: {
        data,
        paging: {
          cursors: { before: `cursor-${start}`, after: `cursor-${end}` },
          ...(more
            ? { next: `https://graph.facebook.com/v26.0/${WABA_ID}/message_templates?after=cursor-${end}` }
            : {}),
        },
      },
    };
  };
}

describe('MetaCloudTemplatesService', () => {
  let graph: FakeGraph;
  let service: MetaCloudTemplatesService;

  const templateRequests = () => graph.requests.filter(r => r.path.split('?')[0].endsWith('/message_templates'));

  beforeEach(async () => {
    graph = await startFakeGraph(pagedScript(3, 2));
    const sessions = {
      findOneBy: ({ id }: { id: string }) => Promise.resolve({ id, engine: 'meta-cloud' }),
    } as unknown as Repository<Session>;
    const accounts = {
      loadCredentials: () => Promise.resolve({ phoneNumberId: '106540352242922', wabaId: WABA_ID, accessToken: TOKEN }),
    } as unknown as MetaCloudAccountStore;
    service = new MetaCloudTemplatesService(
      sessions,
      accounts,
      new MetaGraphClient(() => ({ baseUrl: graph.url, version: 'v26.0', timeoutMs: 2000 })),
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await graph.close();
  });

  it('C22 follows paging.cursors.after across 3 pages and returns every template in order', async () => {
    graph.script = pagedScript(5, 2);

    const templates = await service.list('sess-a');

    const requests = templateRequests();
    expect(requests).toHaveLength(3);
    expect(requests[0].path).toContain(`/v26.0/${WABA_ID}/message_templates?`);
    expect(new URL(requests[0].path, 'http://x').searchParams.get('after')).toBeNull();
    expect(new URL(requests[1].path, 'http://x').searchParams.get('after')).toBe('cursor-2');
    expect(new URL(requests[2].path, 'http://x').searchParams.get('after')).toBe('cursor-4');
    expect(requests.every(r => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(templates.map(t => t.name)).toEqual([
      'template_001',
      'template_002',
      'template_003',
      'template_004',
      'template_005',
    ]);
  });

  it('C22 stops after 500 templates when the pages hold 600', async () => {
    graph.script = pagedScript(600, 100);

    const templates = await service.list('sess-a');

    expect(templates).toHaveLength(500);
    expect(templates[499].name).toBe('template_500');
    expect(templateRequests()).toHaveLength(5);
  });

  it('C22 maps each template to name, language, status, category, parameterFormat and the Graph components unchanged', async () => {
    const components = [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{name}}' },
      { type: 'BODY', text: 'Oi {{first_name}}', example: { body_text_named_params: [{ param_name: 'first_name' }] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Ok' }] },
    ];
    graph.script = () => ({
      status: 200,
      body: {
        data: [
          graphTemplate(1, { name: 'greeting', parameter_format: 'NAMED', category: 'MARKETING', components }),
          graphTemplate(2, { name: 'legacy', status: 'PENDING', parameter_format: undefined }),
        ],
        paging: { cursors: { before: 'a', after: 'b' } },
      },
    });

    const templates = await service.list('sess-a');

    expect(templates).toEqual([
      {
        name: 'greeting',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'MARKETING',
        parameterFormat: 'NAMED',
        components,
      },
      {
        name: 'legacy',
        language: 'pt_BR',
        status: 'PENDING',
        category: 'UTILITY',
        parameterFormat: 'POSITIONAL',
        components: graphTemplate(2).components,
      },
    ]);
  });

  it('C24 caches the list for 5 minutes per session, and refresh=true bypasses the cache', async () => {
    const start = 1_760_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    graph.script = pagedScript(1, 10);

    await service.list('sess-a');
    expect(templateRequests()).toHaveLength(1);

    now.mockReturnValue(start + 4 * 60_000);
    await service.list('sess-a');
    expect(templateRequests()).toHaveLength(1);

    now.mockReturnValue(start + 6 * 60_000);
    await service.list('sess-a');
    expect(templateRequests()).toHaveLength(2);

    now.mockReturnValue(start + 7 * 60_000);
    await service.list('sess-a', true);
    expect(templateRequests()).toHaveLength(3);

    // Another session has an entry of its own.
    await service.list('sess-b');
    expect(templateRequests()).toHaveLength(4);
  });

  it('C55 stores the template name when the template list cannot be read', async () => {
    graph.script = () => ({ status: 500 });

    await expect(
      service.renderBody('sess-unreadable', { name: 'template_001', language: 'pt_BR', parameters: ['Ana'] }),
    ).resolves.toBe('template_001');
    expect(templateRequests()).toHaveLength(1);
  });

  it('C55 stores the template name when the list does not hold the template', async () => {
    graph.script = pagedScript(1, 10);

    await expect(
      service.renderBody('sess-absent', { name: 'not_listed', language: 'pt_BR', parameters: ['Ana'] }),
    ).resolves.toBe('not_listed');
    // The same name in another language is not the same template.
    await expect(
      service.renderBody('sess-absent', { name: 'template_001', language: 'en_US', parameters: ['Ana'] }),
    ).resolves.toBe('template_001');
    // The listed one still renders, so the fallback above is the branch taken, not a broken render.
    await expect(
      service.renderBody('sess-absent', { name: 'template_001', language: 'pt_BR', parameters: ['Ana'] }),
    ).resolves.toBe('Body 1 Ana');
  });
});
