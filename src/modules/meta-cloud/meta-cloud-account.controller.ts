import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { MetaCloudAccountResponseDto, UpdateMetaCloudAccountDto } from './dto/meta-cloud-account.dto';
import { MetaCloudAccountService } from './meta-cloud-account.service';

const NOT_CLOUD_501 = 'The session is not a WhatsApp Cloud API session (its engine is not `meta-cloud`)';
const UNSCOPED_403 = "The key is restricted to specific sessions, or is below the route's role";

/**
 * The Cloud API number behind a `meta-cloud` session (OpenMsg, docs/32 D2). Holds the session's sending
 * credential, so like `POST /api/sessions` it is closed to session-restricted keys.
 */
@ApiTags('sessions')
@Controller('sessions/:sessionId/meta')
export class MetaCloudAccountController {
  constructor(private readonly accounts: MetaCloudAccountService) {}

  @Get('account')
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Get the WhatsApp Cloud API number of a session, without its token' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: MetaCloudAccountResponseDto })
  @ApiResponse({ status: 400, description: 'The session id is not a UUID' })
  @ApiResponse({ status: 403, description: UNSCOPED_403 })
  @ApiResponse({ status: 404, description: 'Session not found, or it has no Cloud API account' })
  @ApiResponse({ status: 501, description: NOT_CLOUD_501 })
  getAccount(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: Request,
  ): Promise<MetaCloudAccountResponseDto> {
    return this.accounts.getAccount(sessionId, webhookUrlOf(req));
  }

  @Put('account')
  @RequireRole(ApiKeyRole.OPERATOR)
  @RequireUnscopedKey()
  @ApiOperation({
    summary: 'Replace the access token of a WhatsApp Cloud API session',
    description:
      "Only `accessToken` can change; binding another number means a new session. The session's next " +
      'Graph call sends the new token; a session in `action_required` needs a stop and start.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: MetaCloudAccountResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Missing or empty `accessToken`, a field other than `accessToken`, or META_CLOUD_ENCRYPTION_KEY is not ' +
      'configured (`META_CLOUD_NOT_CONFIGURED`)',
  })
  @ApiResponse({ status: 403, description: UNSCOPED_403 })
  @ApiResponse({ status: 404, description: 'Session not found, or it has no Cloud API account' })
  @ApiResponse({ status: 501, description: NOT_CLOUD_501 })
  updateAccount(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: UpdateMetaCloudAccountDto,
    @Req() req: Request,
  ): Promise<MetaCloudAccountResponseDto> {
    return this.accounts.rotateToken(sessionId, dto.accessToken, webhookUrlOf(req));
  }
}

/** The callback URL the operator registers with Meta: under BASE_URL when set, else as this request reached the gateway. */
export function webhookUrlOf(req: Request): string {
  // BASE_URL is the public address operators configure: behind a TLS proxy the request itself arrives
  // over plain HTTP (`trust proxy` is off), so it wins, and the request host is the fallback.
  const base = process.env.BASE_URL?.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/meta-webhook`;
}
