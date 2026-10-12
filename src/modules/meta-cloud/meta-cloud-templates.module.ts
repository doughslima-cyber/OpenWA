import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetaCloudAccount } from '../../engine/adapters/meta-cloud-account.entity';
import { MetaCloudAccountStore } from '../../engine/adapters/meta-cloud-account-store.service';
import { MetaCloudContact } from '../../engine/adapters/meta-cloud-contact.entity';
import { MessageModule } from '../message/message.module';
import { Session } from '../session/entities/session.entity';
import { MetaCloudTemplateSendService } from './meta-cloud-template-send.service';
import { MetaCloudTemplatesController } from './meta-cloud-templates.controller';
import { MetaCloudTemplatesService } from './meta-cloud-templates.service';
import { MetaCloudWindowService } from './meta-cloud-window.service';

/**
 * WhatsApp Cloud API templates and the 24-hour service window (OpenMsg, docs/32 F3). A module of its
 * own because the template send goes through MessageModule's send pipeline, while MetaCloudModule is
 * imported by SessionModule, which MessageModule imports.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MetaCloudAccount, MetaCloudContact, Session], 'data'), MessageModule],
  controllers: [MetaCloudTemplatesController],
  providers: [MetaCloudAccountStore, MetaCloudTemplatesService, MetaCloudWindowService, MetaCloudTemplateSendService],
})
export class MetaCloudTemplatesModule {}
