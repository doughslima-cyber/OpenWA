import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from '../session/entities/session.entity';
import { SessionModule } from '../session/session.module';
import { MessageModule } from '../message/message.module';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignsService } from './campaigns.service';
import { CampaignRunner } from './campaign-runner.service';
import { CampaignsController } from './campaigns.controller';

/**
 * Campaigns (OpenMsg): a text sent to a list of numbers through one session, paced over days, with the
 * reply marked and announced on `message.received`. EngineRegistry, HookManager and the lid directory
 * come from @Global modules; nothing imports this module back, so there is no cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Campaign, CampaignRecipient, Session], 'data'), SessionModule, MessageModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignRunner],
})
export class CampaignModule {}
