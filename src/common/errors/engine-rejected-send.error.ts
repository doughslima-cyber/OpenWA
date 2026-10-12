import { HttpException } from '@nestjs/common';

/**
 * A send the engine's upstream answered with an explicit refusal (OpenMsg, docs/32): the WhatsApp
 * Cloud API returned an error naming why it did not take the message, so nothing was sent. Carries
 * a 4xx status and a machine-readable body (`{ statusCode, error, message, code, ... }`).
 *
 * Distinct from a failure whose outcome is unknown (a timeout, a dropped connection, an upstream 5xx):
 * the send-idempotency interceptor frees the key for this one, so a corrected retry may reuse it.
 */
export class EngineRejectedSendError extends HttpException {
  constructor(body: { statusCode: number; error: string; message: string; code: string } & Record<string, unknown>) {
    super(body, body.statusCode);
  }
}
