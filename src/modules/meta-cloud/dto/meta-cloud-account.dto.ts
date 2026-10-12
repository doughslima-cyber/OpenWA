import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** `PUT /api/sessions/:sessionId/meta/account`: only the token can change; a new number is a new session. */
export class UpdateMetaCloudAccountDto {
  @ApiProperty({
    description: 'New system-user access token. Stored encrypted and never returned by any route.',
    writeOnly: true,
    maxLength: 2048,
    example: 'EAAG...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  accessToken!: string;
}

/** The Cloud API number of a `meta-cloud` session, without its token (OpenMsg, docs/32 D2). */
export class MetaCloudAccountResponseDto {
  @ApiProperty({ example: '106540352242922' })
  phoneNumberId!: string;

  @ApiProperty({ example: '102290129340398' })
  wabaId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '+55 11 99999-0000',
    description: 'As Graph last reported it; null until the session first starts',
  })
  displayPhoneNumber!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Acme' })
  verifiedName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'GREEN' })
  qualityRating!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'TIER_1K' })
  messagingLimitTier!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'x9Zq',
    description: 'Last 4 characters of the stored token; null after a logout cleared it',
  })
  accessTokenLast4!: string | null;

  @ApiProperty({
    example: 'https://openmsg.example.com/api/meta-webhook',
    description: 'The callback URL to register in the Meta app',
  })
  webhookUrl!: string;
}
