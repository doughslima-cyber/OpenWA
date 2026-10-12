import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineFactory } from './engine.factory';
import { BaileysStoredMessage } from './adapters/baileys-stored-message.entity';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMapping } from './identity/lid-mapping.entity';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { ChatState } from './adapters/baileys-chat-state.entity';
import { ChatStateStoreService } from './adapters/baileys-chat-state-store.service';
import { EngineRegistry } from './engine-registry.service';
import { MetaCloudAccount } from './adapters/meta-cloud-account.entity';
import { MetaCloudAccountStore } from './adapters/meta-cloud-account-store.service';
import { MetaCloudContact } from './adapters/meta-cloud-contact.entity';
import { MetaCloudChatStore } from './adapters/meta-cloud-chat-store.service';
import { MetaCloudNumberRegistry } from './adapters/meta-cloud-number-registry';
import { Message } from '../modules/message/entities/message.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(
      // OpenMsg: Message is read by MetaCloudChatStore, a Cloud session's chat list and history (docs/32 D6)
      [BaileysStoredMessage, LidMapping, ChatState, MetaCloudAccount, MetaCloudContact, Message],
      'data',
    ),
  ],
  // EngineRegistry is exported from this @Global module so the feature services that only need a
  // live engine can inject it directly, instead of importing SessionModule to reach the lifecycle
  // owner. It is a singleton by DI, which is what makes it a safe single source of truth.
  providers: [
    EngineFactory,
    BaileysMessageStoreService,
    LidMappingStoreService,
    ChatStateStoreService,
    EngineRegistry,
    MetaCloudAccountStore, // OpenMsg: Cloud API account rows for the meta-cloud engine (docs/32)
    MetaCloudNumberRegistry, // OpenMsg: live Cloud numbers, read by the /api/meta-webhook router
    MetaCloudChatStore, // OpenMsg: meta_cloud_contacts and the chat reads of a Cloud session
  ],
  exports: [EngineFactory, LidMappingStoreService, ChatStateStoreService, EngineRegistry, MetaCloudNumberRegistry],
})
export class EngineModule {}
