import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { MessageResponseDto } from '../message/dto';
import { MessageSendService } from '../message/message-send.service';
import { Session } from '../session/entities/session.entity';
import { SendMetaTemplateDto } from './dto/meta-cloud-templates.dto';
import { MetaCloudTemplatesService, requireCloudSession } from './meta-cloud-templates.service';

/**
 * Sends an approved Meta template on a `meta-cloud` session (OpenMsg, docs/32 F3): 404 for an unknown
 * session, 501 for one that is not a Cloud session, 409 for one that is not ready, then the shared
 * send pipeline, which stores the template body with its parameters filled in.
 */
@Injectable()
export class MetaCloudTemplateSendService {
  constructor(
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    private readonly engines: EngineRegistry,
    private readonly templates: MetaCloudTemplatesService,
    private readonly sender: MessageSendService,
  ) {}

  async send(sessionId: string, dto: SendMetaTemplateDto): Promise<MessageResponseDto> {
    await requireCloudSession(this.sessions, sessionId);
    if (this.engines.get(sessionId)?.getStatus() !== EngineStatus.READY) throw new EngineNotReadyError();
    return this.sender.sendCloudTemplate(
      sessionId,
      { chatId: dto.chatId, name: dto.name, language: dto.language, parameters: dto.parameters },
      input => this.templates.renderBody(sessionId, input),
    );
  }
}
