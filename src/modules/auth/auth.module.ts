import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { ActiveKeyIndex } from './active-key-index';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { AuthLoginController } from './auth-login.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, User, UserSession], 'main')],
  controllers: [AuthController, AuthValidateController, AuthLoginController, UsersController],
  providers: [
    AuthService,
    ApiKeyUsageTracker,
    ChatScopeService,
    ActiveKeyIndex,
    UsersService,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, ChatScopeService, ActiveKeyIndex],
})
export class AuthModule {}
