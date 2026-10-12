import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MetaCloudAccount } from '../../engine/adapters/meta-cloud-account.entity';
import { Session } from '../session/entities/session.entity';
import { MetaCloudAccountController } from './meta-cloud-account.controller';
import { MetaCloudAccountService } from './meta-cloud-account.service';
import { MetaCloudWebhookController } from './meta-cloud-webhook.controller';
import { MetaCloudWebhookRouter } from './meta-cloud-router.service';

/**
 * WhatsApp Cloud API sessions (OpenMsg, docs/32): the account behind a `meta-cloud` session. Imported
 * by SessionModule, whose create binds the account in the same transaction; it imports nothing back.
 * Also the `/api/meta-webhook` receiver, which routes Meta's events to the live sessions through
 * the engine module's number registry.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MetaCloudAccount, Session], 'data')],
  controllers: [MetaCloudAccountController, MetaCloudWebhookController],
  providers: [MetaCloudAccountService, MetaCloudWebhookRouter],
  exports: [MetaCloudAccountService],
})
export class MetaCloudModule {}
