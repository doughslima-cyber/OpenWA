import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** The WhatsApp Cloud API number a `meta-cloud` session is bound to (OpenMsg, docs/32 D2). */
export class MetaCloudCredentialsDto {
  @ApiProperty({ description: 'Phone Number ID of the number in Meta', example: '106540352242922', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  phoneNumberId!: string;

  @ApiProperty({
    description: 'WhatsApp Business Account ID that owns the number',
    example: '102290129340398',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  wabaId!: string;

  @ApiProperty({
    description: 'System-user access token. Stored encrypted and never returned by any route.',
    writeOnly: true,
    maxLength: 2048,
    example: 'EAAG...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  accessToken!: string;
}
