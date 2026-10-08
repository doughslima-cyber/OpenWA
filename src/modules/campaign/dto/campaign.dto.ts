import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../message/dto/send-message.dto';
import { CAMPAIGN_STATUSES, CAMPAIGN_WAIT_REASONS, type CampaignStatus } from '../entities/campaign.entity';
import { RECIPIENT_STATUSES, type RecipientStatus } from '../entities/campaign-recipient.entity';

/** Most accepted numbers one campaign may hold. */
export const CAMPAIGN_RECIPIENTS_MAX = 5000;
export const CAMPAIGN_NAME_MAX_LENGTH = 100;
export const CAMPAIGN_RECIPIENTS_PAGE_DEFAULT = 50;
export const CAMPAIGN_RECIPIENTS_PAGE_MAX = 100;

export class CreateCampaignDto {
  @ApiProperty({ description: 'Name shown in the campaign list', example: 'October follow-up', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'name must not be empty' })
  @MaxCodePoints(CAMPAIGN_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiProperty({
    description: 'Text sent to every recipient',
    example: 'Hi! We have news about your order.',
    maxLength: MESSAGE_TEXT_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  @Matches(/\S/, { message: 'text must not be empty' })
  @NoNulCharacter()
  text!: string;

  @ApiProperty({
    description:
      'Phone numbers, as typed or as read from a .csv/.txt file. An entry may hold several numbers ' +
      'separated by line breaks, commas, semicolons or tabs; spaces, parentheses, hyphens and a leading ' +
      'plus are ignored. Accepted: at least 6 digits, or `<digits>@c.us` / `<digits>@s.whatsapp.net`; ' +
      `groups, lids and channels are dropped. Duplicates count once; at most ${CAMPAIGN_RECIPIENTS_MAX} accepted.`,
    example: ['+55 (11) 98888-7777', '5511977776666'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  recipients!: string[];
}

export class ListRecipientsQueryDto {
  @ApiPropertyOptional({ enum: RECIPIENT_STATUSES, description: 'Only recipients in this status' })
  @IsOptional()
  @IsIn(RECIPIENT_STATUSES)
  status?: RecipientStatus;

  @ApiPropertyOptional({
    description: 'Page size',
    default: CAMPAIGN_RECIPIENTS_PAGE_DEFAULT,
    minimum: 1,
    maximum: CAMPAIGN_RECIPIENTS_PAGE_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CAMPAIGN_RECIPIENTS_PAGE_MAX)
  limit?: number;

  @ApiPropertyOptional({ description: 'Rows to skip', default: 0, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

export class CampaignCountsDto {
  @ApiProperty() total!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() sending!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() replied!: number;
  @ApiProperty() cancelled!: number;
}

export class CampaignCreatedDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: CAMPAIGN_STATUSES }) status!: CampaignStatus;
  @ApiProperty({ description: 'Distinct accepted recipients' }) total!: number;
}

export class CampaignSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: CAMPAIGN_STATUSES }) status!: CampaignStatus;
  @ApiProperty({
    type: CampaignCountsDto,
    description: 'Recipients by current status; the buckets sum to total',
  })
  counts!: CampaignCountsDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: Date, nullable: true }) completedAt!: Date | null;
}

export class CampaignWaitingDto {
  @ApiProperty({
    enum: CAMPAIGN_WAIT_REASONS,
    description:
      '`pacing`: the session send allowance is spent until nextAttemptAt; `restricted`: WhatsApp restricts ' +
      'the account; `disconnected`: the session is not ready',
  })
  reason!: string;
  @ApiProperty({ type: Date, nullable: true }) nextAttemptAt!: Date | null;
}

export class CampaignDetailDto extends CampaignSummaryDto {
  @ApiProperty() text!: string;
  @ApiProperty({
    type: CampaignWaitingDto,
    nullable: true,
    description: 'Why a running campaign is not sending right now; null while it sends or once it ended',
  })
  waiting!: CampaignWaitingDto | null;
}

export class CampaignCancelledDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: CAMPAIGN_STATUSES }) status!: CampaignStatus;
  @ApiProperty({ type: CampaignCountsDto }) counts!: CampaignCountsDto;
}

export class CampaignRecipientErrorDto {
  @ApiProperty({ example: 'SEND_FAILED', description: 'SEND_FAILED, SEND_BLOCKED or SEND_INTERRUPTED' })
  code!: string;
  @ApiProperty() message!: string;
}

export class CampaignRecipientDto {
  @ApiProperty({ example: '5511988887777@c.us' }) chatId!: string;
  @ApiProperty({ enum: RECIPIENT_STATUSES }) status!: RecipientStatus;
  @ApiProperty({ type: Date, nullable: true }) sentAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) repliedAt!: Date | null;
  @ApiProperty({ type: CampaignRecipientErrorDto, nullable: true }) error!: CampaignRecipientErrorDto | null;
}

export class CampaignRecipientPageDto {
  @ApiProperty({ type: [CampaignRecipientDto] }) items!: CampaignRecipientDto[];
  @ApiProperty({ description: 'Recipients matching the filter' }) total!: number;
}
