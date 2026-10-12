import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ENGINE_NOT_READY_409 } from '../../common/openapi/engine-status-responses';
import { ChatScoped, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { MessageResponseDto } from '../message/dto';
import { IdempotentSend } from '../message/idempotency/idempotent-send.decorator';
import {
  MetaChatWindowResponseDto,
  MetaTemplateListResponseDto,
  SendMetaTemplateDto,
} from './dto/meta-cloud-templates.dto';
import { MetaCloudTemplateSendService } from './meta-cloud-template-send.service';
import { MetaCloudTemplatesService } from './meta-cloud-templates.service';
import { MetaCloudWindowService } from './meta-cloud-window.service';

const NOT_CLOUD_501 = 'The session is not a WhatsApp Cloud API session (its engine is not `meta-cloud`)';
const GRAPH_502 = '`META_UPSTREAM_ERROR`: Graph answered with an error the gateway does not map; `metaCode` names it';
const GRAPH_503 = 'Graph did not answer (refused, reset or timed out)';

/**
 * Message templates and the 24-hour customer service window of a `meta-cloud` session (OpenMsg,
 * docs/32 F3): what the dashboard needs to reach a customer whose window has closed.
 */
@ApiTags('sessions')
@Controller('sessions/:sessionId/meta')
export class MetaCloudTemplatesController {
  constructor(
    private readonly templates: MetaCloudTemplatesService,
    private readonly windows: MetaCloudWindowService,
    private readonly sender: MetaCloudTemplateSendService,
  ) {}

  @Get('templates')
  @RequireUnscopedKey()
  @ApiOperation({
    summary: "List the message templates of a WhatsApp Cloud API session's account",
    description:
      "Every template of the WABA (up to 500), with Meta's `components` unchanged. Cached for 5 minutes per " +
      'session; `refresh=true` reads Graph again.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean, description: 'Bypass the 5-minute cache' })
  @ApiResponse({ status: 200, type: MetaTemplateListResponseDto })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({
    status: 409,
    description: 'Meta refused the token (`META_TOKEN_INVALID`), or the session has no usable token',
  })
  @ApiResponse({ status: 501, description: NOT_CLOUD_501 })
  @ApiResponse({ status: 502, description: GRAPH_502 })
  @ApiResponse({ status: 503, description: GRAPH_503 })
  async listTemplates(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query('refresh') refresh?: string,
  ): Promise<MetaTemplateListResponseDto> {
    return { templates: await this.templates.list(sessionId, refresh === 'true' || refresh === '1') };
  }

  @ChatScoped('fenced')
  @Get('chats/:chatId/window')
  @ApiOperation({
    summary: 'Get the 24-hour customer service window of a WhatsApp Cloud API chat',
    description:
      "Free-form messages are allowed until 24 hours after the customer's last message; after that only an " +
      'approved template can be sent.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat ID (`<digits>@c.us`)' })
  @ApiResponse({ status: 200, type: MetaChatWindowResponseDto })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 501, description: NOT_CLOUD_501 })
  getWindow(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('chatId') chatId: string,
  ): Promise<MetaChatWindowResponseDto> {
    return this.windows.window(sessionId, chatId);
  }

  @ChatScoped('fenced')
  @Post('send-template')
  @IdempotentSend()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Send an approved Meta message template on a WhatsApp Cloud API session',
    description:
      'The only message Meta accepts outside the 24-hour service window. `parameters` fills the body: an array ' +
      'for a positional template, an object keyed by placeholder name for a named one. The stored message holds ' +
      'the body with its parameters filled in.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Template sent', type: MessageResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Invalid body, a plugin blocked the send, or Meta refused the template (`META_TEMPLATE_INVALID`, ' +
      "Graph codes 132000-132016) or the recipient; `metaCode` names Meta's code",
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({
    status: 409,
    description: `${ENGINE_NOT_READY_409} Also \`META_TOKEN_INVALID\` and \`META_ACCOUNT_RESTRICTED\`.`,
  })
  @ApiResponse({ status: 429, description: '`META_LIMIT_REACHED` or `META_RATE_LIMITED`' })
  @ApiResponse({ status: 501, description: NOT_CLOUD_501 })
  @ApiResponse({ status: 502, description: GRAPH_502 })
  @ApiResponse({ status: 503, description: GRAPH_503 })
  sendTemplate(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: SendMetaTemplateDto,
  ): Promise<MessageResponseDto> {
    return this.sender.send(sessionId, dto);
  }
}
