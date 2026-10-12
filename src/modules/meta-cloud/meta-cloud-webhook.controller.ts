import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createLogger } from '../../common/services/logger.service';
import { safeEqualStr } from '../integration/ingress-signature';
import { isMetaCloudEnabled } from '../../engine/session-engine';
import { Public } from '../auth/decorators/auth.decorators';
import { isValidMetaSignature } from './meta-cloud-webhook-signature';
import { MetaCloudWebhookRouter } from './meta-cloud-router.service';

const DISABLED_404 = 'META_CLOUD_ENABLED is not `true`: Cloud API sessions are switched off';

/** Express answers a repeated query parameter with an array; the first value wins. */
function first(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

/**
 * The callback URL operators register in their Meta app (OpenMsg, docs/32, door 6).
 *
 * @Public because Meta presents no API key: the GET handshake is gated by META_WEBHOOK_VERIFY_TOKEN
 * and every POST by the `X-Hub-Signature-256` HMAC under META_APP_SECRET, computed over the exact
 * bytes `configure-app.ts` keeps on req.rawBody. @SkipThrottle because Meta delivers in bursts from
 * few addresses and a 429 would push inbound messages into its retry backoff; the HMAC is the gate.
 */
@ApiTags('integration')
@Public()
@SkipThrottle()
@Controller('meta-webhook')
export class MetaCloudWebhookController {
  private readonly logger = createLogger('MetaCloudWebhookController');
  /** The unset META_APP_SECRET is logged once per process, not once per delivery Meta retries. */
  private secretUnsetLogged = false;

  constructor(private readonly router: MetaCloudWebhookRouter) {}

  @Get()
  @ApiOperation({ summary: "Meta's webhook verification handshake (WhatsApp Cloud API sessions)" })
  @ApiQuery({ name: 'hub.mode', type: String, required: false, description: 'Must be `subscribe`' })
  @ApiQuery({
    name: 'hub.verify_token',
    type: String,
    required: false,
    description: 'Must equal META_WEBHOOK_VERIFY_TOKEN',
  })
  @ApiQuery({ name: 'hub.challenge', type: String, required: false, description: 'Echoed back as the body' })
  @ApiOkResponse({ description: '`hub.challenge`, as `text/plain`' })
  @ApiResponse({
    status: 403,
    description: '`hub.mode` is not `subscribe`, the token differs, or META_WEBHOOK_VERIFY_TOKEN is unset',
  })
  @ApiResponse({ status: 404, description: DISABLED_404 })
  verify(@Query() query: Record<string, unknown>, @Res() res: Response): void {
    this.assertEnabled();
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
    const token = first(query['hub.verify_token']);
    if (first(query['hub.mode']) !== 'subscribe' || !expected || !safeEqualStr(token, expected)) {
      throw new ForbiddenException('Webhook verification failed');
    }
    // The challenge is Meta's string reflected back: text/plain, never the html Express would pick.
    res.type('text/plain').status(200).send(first(query['hub.challenge']));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive WhatsApp Cloud API events from Meta',
    description:
      'Answers 200 before the events are processed. Each `messages` change goes to the session live in this ' +
      'process for its `phone_number_id`; a change for a number with no Cloud API account here is logged and ' +
      'dropped. A body naming a number that has an account but no live session in this process (restarting, ' +
      'not started) is refused with 503 and nothing in it is processed, so Meta delivers it again later.',
  })
  @ApiOkResponse({
    description: 'Accepted (also for a duplicate delivery and for a number with no Cloud API account here)',
  })
  @ApiResponse({ status: 401, description: '`X-Hub-Signature-256` is missing or is not the HMAC of the body' })
  @ApiResponse({ status: 404, description: DISABLED_404 })
  @ApiResponse({
    status: 503,
    description:
      'META_APP_SECRET is not set, so no delivery can be verified; or the body names a number whose Cloud API ' +
      'session is not live in this process, so Meta retries it later',
  })
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<void> {
    this.assertEnabled();
    const secret = process.env.META_APP_SECRET ?? '';
    if (!secret) {
      if (!this.secretUnsetLogged) {
        this.secretUnsetLogged = true;
        this.logger.error('META_APP_SECRET is not set: every Meta webhook delivery is refused with 503', undefined, {
          action: 'meta_webhook_secret_unset',
        });
      }
      throw new ServiceUnavailableException('The Meta webhook is not configured');
    }
    if (!isValidMetaSignature(req.rawBody, signature, secret)) {
      throw new UnauthorizedException('Invalid X-Hub-Signature-256');
    }
    const body: unknown = req.body;
    // Meta never redelivers a 2xx: a message for a number whose session is not live here yet (a restart)
    // is refused whole, and Meta's retry brings it back once the session is READY (Landing 16).
    const notLive = await this.router.knownNumbersNotLive(body);
    if (notLive.length > 0) {
      this.logger.warn(`Refused a Meta webhook delivery with 503: no live session for ${notLive.join(', ')}`, {
        phoneNumberIds: notLive,
        action: 'meta_webhook_session_not_live',
      });
      throw new ServiceUnavailableException('A WhatsApp Cloud API session for this number is not live yet');
    }
    // After the answer: Meta times a delivery out and retries it, so nothing downstream may hold the 200.
    setImmediate(() => {
      Promise.resolve()
        .then(() => this.router.handle(body))
        .catch((error: unknown) =>
          this.logger.error(
            'Processing a Meta webhook delivery failed',
            error instanceof Error ? error.message : String(error),
            { action: 'meta_webhook_failed' },
          ),
        );
    });
  }

  private assertEnabled(): void {
    if (!isMetaCloudEnabled()) throw new NotFoundException();
  }
}
