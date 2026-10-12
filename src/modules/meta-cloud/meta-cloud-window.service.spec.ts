import type { Repository } from 'typeorm';
import type { MetaCloudContact } from '../../engine/adapters/meta-cloud-contact.entity';
import type { Session } from '../session/entities/session.entity';
import { MetaCloudWindowService } from './meta-cloud-window.service';

const NOW = Date.parse('2026-10-12T15:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('MetaCloudWindowService', () => {
  let contact: Partial<MetaCloudContact> | null;
  let asked: unknown[];
  let service: MetaCloudWindowService;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    contact = null;
    asked = [];
    const sessions = {
      findOneBy: ({ id }: { id: string }) => Promise.resolve({ id, engine: 'meta-cloud' }),
    } as unknown as Repository<Session>;
    const contacts = {
      findOneBy: (where: unknown) => {
        asked.push(where);
        return Promise.resolve(contact);
      },
    } as unknown as Repository<MetaCloudContact>;
    service = new MetaCloudWindowService(sessions, contacts);
  });

  afterEach(() => jest.restoreAllMocks());

  it('C27 is open with closesAt exactly 24 h after an inbound message 23 h 59 min ago', async () => {
    const lastInboundAt = new Date(NOW - (23 * HOUR + 59 * MINUTE));
    contact = { lastInboundAt };

    const window = await service.window('sess-a', '5511988887777@c.us');

    expect(window).toEqual({
      lastInboundAt: lastInboundAt.toISOString(),
      open: true,
      closesAt: new Date(lastInboundAt.getTime() + 24 * HOUR).toISOString(),
    });
    expect(window.closesAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(asked).toEqual([{ sessionId: 'sess-a', waId: '5511988887777' }]);
  });

  it('C27 is closed for an inbound message 24 h 1 min ago', async () => {
    const lastInboundAt = new Date(NOW - (24 * HOUR + MINUTE));
    contact = { lastInboundAt };

    const window = await service.window('sess-a', '5511988887777@c.us');

    expect(window).toEqual({
      lastInboundAt: lastInboundAt.toISOString(),
      open: false,
      closesAt: new Date(lastInboundAt.getTime() + 24 * HOUR).toISOString(),
    });
  });

  it('C27 answers no window for a chat with no contact row', async () => {
    contact = null;

    await expect(service.window('sess-a', '5511988887777@c.us')).resolves.toEqual({
      lastInboundAt: null,
      open: false,
      closesAt: null,
    });
  });
});
