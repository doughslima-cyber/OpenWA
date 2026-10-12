import { ConflictException, NotFoundException, NotImplementedException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import type { MessageSendService } from '../message/message-send.service';
import type { Session } from '../session/entities/session.entity';
import { MetaCloudTemplateSendService } from './meta-cloud-template-send.service';
import type { MetaCloudTemplatesService } from './meta-cloud-templates.service';

describe('MetaCloudTemplateSendService', () => {
  const DTO = { chatId: '5511988887777@c.us', name: 'order_shipped', language: 'pt_BR', parameters: ['Ana', '42'] };

  const build = (row: Partial<Session> | null, status?: EngineStatus) => {
    const sessions = { findOneBy: () => Promise.resolve(row) } as unknown as Repository<Session>;
    const engines = {
      get: () => (status ? { getStatus: () => status } : undefined),
    } as unknown as EngineRegistry;
    const templates = {
      renderBody: jest.fn(() => Promise.resolve('rendered')),
    } as unknown as MetaCloudTemplatesService;
    const sendCloudTemplate = jest.fn(() => Promise.resolve({ messageId: 'wamid.X', timestamp: 1 }));
    const sender = { sendCloudTemplate } as unknown as MessageSendService;
    return { service: new MetaCloudTemplateSendService(sessions, engines, templates, sender), sendCloudTemplate };
  };

  it('C56 answers 404 for an unknown session, 501 for a non-Cloud one and 409 for a Cloud one not ready, sending nothing', async () => {
    const unknown = build(null, EngineStatus.READY);
    await expect(unknown.service.send('s1', DTO)).rejects.toBeInstanceOf(NotFoundException);

    const qr = build({ id: 's1', engine: 'baileys' }, EngineStatus.READY);
    await expect(qr.service.send('s1', DTO)).rejects.toBeInstanceOf(NotImplementedException);

    for (const status of [undefined, EngineStatus.INITIALIZING, EngineStatus.ACTION_REQUIRED]) {
      const idle = build({ id: 's1', engine: 'meta-cloud' }, status);
      await expect(idle.service.send('s1', DTO)).rejects.toBeInstanceOf(ConflictException);
      expect(idle.sendCloudTemplate).not.toHaveBeenCalled();
    }
    expect(unknown.sendCloudTemplate).not.toHaveBeenCalled();
    expect(qr.sendCloudTemplate).not.toHaveBeenCalled();
  });

  it('C56 hands a READY Cloud session the template send with its fields', async () => {
    const ready = build({ id: 's1', engine: 'meta-cloud' }, EngineStatus.READY);

    await expect(ready.service.send('s1', DTO)).resolves.toEqual({ messageId: 'wamid.X', timestamp: 1 });
    expect(ready.sendCloudTemplate).toHaveBeenCalledWith('s1', DTO, expect.any(Function));
  });
});
