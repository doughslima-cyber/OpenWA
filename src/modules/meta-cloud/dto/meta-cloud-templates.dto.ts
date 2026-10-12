import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateBy, ValidationOptions } from 'class-validator';

/** One message template of the account's WABA, with Meta's `components` unchanged (OpenMsg, docs/32 F3 door 3). */
export class MetaTemplateDto {
  @ApiProperty({ example: 'order_shipped' })
  name!: string;

  @ApiProperty({ example: 'pt_BR' })
  language!: string;

  @ApiProperty({ example: 'APPROVED', description: 'As Meta reports it: APPROVED, PENDING, REJECTED, PAUSED, ...' })
  status!: string;

  @ApiProperty({ example: 'UTILITY', description: 'MARKETING, UTILITY or AUTHENTICATION' })
  category!: string;

  @ApiProperty({
    example: 'POSITIONAL',
    description: "Meta's `parameter_format`: POSITIONAL (`{{1}}`) or NAMED (`{{first_name}}`); POSITIONAL when absent",
  })
  parameterFormat!: string;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: "Meta's template components (HEADER, BODY, FOOTER, BUTTONS), unchanged",
    example: [{ type: 'BODY', text: 'Olá {{1}}, seu pedido {{2}} saiu' }],
  })
  components!: unknown[];
}

/** `GET /api/sessions/:sessionId/meta/templates`. */
export class MetaTemplateListResponseDto {
  @ApiProperty({ type: [MetaTemplateDto] })
  templates!: MetaTemplateDto[];
}

/** `GET /api/sessions/:sessionId/meta/chats/:chatId/window`: the 24-hour customer service window (F3 door 5). */
export class MetaChatWindowResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-12T14:03:00.000Z',
    description: "The customer's last inbound message, ISO 8601 UTC; null when the chat never wrote",
  })
  lastInboundAt!: string | null;

  @ApiProperty({
    example: true,
    description: 'Whether free-form messages are allowed now (closesAt is later than now)',
  })
  open!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-13T14:03:00.000Z',
    description: 'lastInboundAt plus 24 hours, ISO 8601 UTC; null when the chat never wrote',
  })
  closesAt!: string | null;
}

/** An array of strings, or an object whose values are all strings. */
function IsTemplateParameters(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isTemplateParameters',
      validator: {
        validate: (value: unknown): boolean => {
          if (Array.isArray(value)) return value.every(v => typeof v === 'string');
          if (typeof value !== 'object' || value === null) return false;
          return Object.values(value).every(v => typeof v === 'string');
        },
        defaultMessage: () =>
          'parameters must be an array of strings (positional) or an object of string values (named)',
      },
    },
    options,
  );
}

/** `POST /api/sessions/:sessionId/meta/send-template` (F3 door 2). */
export class SendMetaTemplateDto {
  @ApiProperty({ example: '5511988887777@c.us' })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({ example: 'order_shipped', maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  name!: string;

  @ApiProperty({ example: 'pt_BR', maxLength: 32 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  language!: string;

  @ApiPropertyOptional({
    oneOf: [
      { type: 'array', items: { type: 'string' } },
      { type: 'object', additionalProperties: { type: 'string' } },
    ],
    description:
      'The body parameters: an array for a positional template (`{{1}}`, `{{2}}`, in order), an object keyed by ' +
      'placeholder name for a named one. Omit for a template with no body parameters.',
    example: ['Ana', '42'],
  })
  @IsOptional()
  @IsTemplateParameters()
  parameters?: string[] | Record<string, string>;
}
