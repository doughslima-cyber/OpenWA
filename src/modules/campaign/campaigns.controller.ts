import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { CampaignsService } from './campaigns.service';
import {
  CampaignCancelledDto,
  CampaignCreatedDto,
  CampaignDetailDto,
  CampaignRecipientPageDto,
  CampaignSummaryDto,
  CreateCampaignDto,
  ListRecipientsQueryDto,
} from './dto/campaign.dto';

const CHAT_RESTRICTED_403 =
  'The calling key is restricted with `allowedChats`: a campaign reaches numbers outside any chat ' +
  "allowlist, so a chat-restricted key is refused. Also returned for a key below the route's role.";

// No @ChatScoped on purpose: the guard's default-deny keeps chat-restricted keys off every route here.
@ApiTags('campaigns')
@Controller('sessions/:sessionId/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and start a campaign: one text to a list of numbers, paced over days' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Campaign created and running', type: CampaignCreatedDto })
  @ApiResponse({
    status: 400,
    description:
      'Invalid name or text, or the list holds no phone number (`CAMPAIGN_NO_RECIPIENTS`) or more than 5000 ' +
      '(`CAMPAIGN_TOO_MANY_RECIPIENTS`)',
  })
  @ApiResponse({ status: 403, description: CHAT_RESTRICTED_403 })
  @ApiResponse({ status: 404, description: 'No session with this id' })
  @ApiResponse({
    status: 409,
    description: 'The session already has a running campaign (`CAMPAIGN_ALREADY_RUNNING`)',
  })
  create(@Param('sessionId') sessionId: string, @Body() dto: CreateCampaignDto): Promise<CampaignCreatedDto> {
    return this.campaigns.create(sessionId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the session's campaigns, newest first" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: CampaignSummaryDto, isArray: true })
  @ApiResponse({ status: 403, description: CHAT_RESTRICTED_403 })
  @ApiResponse({ status: 404, description: 'No session with this id' })
  list(@Param('sessionId') sessionId: string): Promise<CampaignSummaryDto[]> {
    return this.campaigns.list(sessionId);
  }

  @Get(':campaignId')
  @ApiOperation({ summary: 'Get a campaign, its counts and why it is waiting' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'campaignId', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignDetailDto })
  @ApiResponse({ status: 403, description: CHAT_RESTRICTED_403 })
  @ApiResponse({ status: 404, description: 'No such campaign in this session' })
  findOne(@Param('sessionId') sessionId: string, @Param('campaignId') campaignId: string): Promise<CampaignDetailDto> {
    return this.campaigns.findOne(sessionId, campaignId);
  }

  @Get(':campaignId/recipients')
  @ApiOperation({ summary: "List a campaign's recipients in list order, filtered by status and paged" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'campaignId', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignRecipientPageDto })
  @ApiResponse({ status: 400, description: 'Unknown status, or limit outside 1-100, or a negative offset' })
  @ApiResponse({ status: 403, description: CHAT_RESTRICTED_403 })
  @ApiResponse({ status: 404, description: 'No such campaign in this session' })
  recipients(
    @Param('sessionId') sessionId: string,
    @Param('campaignId') campaignId: string,
    @Query() query: ListRecipientsQueryDto,
  ): Promise<CampaignRecipientPageDto> {
    return this.campaigns.listRecipients(sessionId, campaignId, query);
  }

  @Post(':campaignId/cancel')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running campaign; recipients not yet sent are cancelled' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'campaignId', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignCancelledDto })
  @ApiResponse({ status: 403, description: CHAT_RESTRICTED_403 })
  @ApiResponse({ status: 404, description: 'No such campaign in this session' })
  @ApiResponse({ status: 409, description: 'The campaign is already completed or cancelled (`CAMPAIGN_NOT_RUNNING`)' })
  cancel(
    @Param('sessionId') sessionId: string,
    @Param('campaignId') campaignId: string,
  ): Promise<CampaignCancelledDto> {
    return this.campaigns.cancel(sessionId, campaignId);
  }
}
