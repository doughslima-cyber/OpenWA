import { BadGatewayException, HttpException } from '@nestjs/common';
import { EngineRejectedSendError } from '../../common/errors/engine-rejected-send.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';
import { META_GRAPH_API_VERSION_DEFAULT } from '../session-engine';

/**
 * The HTTP client a `meta-cloud` session talks to Graph through (OpenMsg, docs/32).
 *
 * Native `fetch` with a per-call timeout. A call that never got an answer (refused, reset, timed
 * out) raises EngineTransportError (503); an answer that is not 2xx raises MetaGraphError carrying
 * Meta's error fields, which `send()` maps to the HTTP error a caller sees. The token travels only in the Authorization header: no log line and no error
 * message built here carries it, and Meta's own `message` is scrubbed of it before it is kept.
 */

export const META_GRAPH_BASE_URL_DEFAULT = 'https://graph.facebook.com';
export const META_CLOUD_TIMEOUT_MS_DEFAULT = 15_000;
export const META_CLOUD_MAX_RPS_DEFAULT = 40;
/** Waits before the 2nd and 3rd attempt of a send Graph throttled with `130429`. */
export const META_RATE_LIMIT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/** Graph error codes that mean the token is expired, revoked or lacks the permission. */
export const META_TOKEN_INVALID_CODES: ReadonlySet<number> = new Set([190, 10, 200]);

export interface MetaGraphConfig {
  baseUrl: string;
  version: string;
  timeoutMs: number;
  /** Graph calls one phone number may start per second; further ones wait. Defaults to 40. */
  maxRps?: number;
}

/** Read at call time, like the other Cloud API settings, so a test can point it at a fake Graph. */
export function resolveMetaGraphConfig(env: NodeJS.ProcessEnv = process.env): MetaGraphConfig {
  const timeout = Number.parseInt(env.META_CLOUD_TIMEOUT_MS ?? '', 10);
  const maxRps = Number.parseInt(env.META_CLOUD_MAX_RPS ?? '', 10);
  return {
    baseUrl: (env.META_GRAPH_BASE_URL || META_GRAPH_BASE_URL_DEFAULT).replace(/\/+$/, ''),
    version: env.META_GRAPH_API_VERSION || META_GRAPH_API_VERSION_DEFAULT,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : META_CLOUD_TIMEOUT_MS_DEFAULT,
    maxRps: Number.isFinite(maxRps) && maxRps > 0 ? maxRps : META_CLOUD_MAX_RPS_DEFAULT,
  };
}

/** Graph answered with a non-2xx status. */
export class MetaGraphError extends Error {
  readonly httpStatus: number;
  readonly metaCode?: number;
  readonly metaSubcode?: number;
  readonly metaType?: string;
  readonly fbtraceId?: string;

  constructor(fields: {
    httpStatus: number;
    message: string;
    metaCode?: number;
    metaSubcode?: number;
    metaType?: string;
    fbtraceId?: string;
  }) {
    super(fields.message);
    this.name = 'MetaGraphError';
    this.httpStatus = fields.httpStatus;
    this.metaCode = fields.metaCode;
    this.metaSubcode = fields.metaSubcode;
    this.metaType = fields.metaType;
    this.fbtraceId = fields.fbtraceId;
  }
}

export function isMetaTokenInvalid(error: unknown): error is MetaGraphError {
  return (
    error instanceof MetaGraphError && error.metaCode !== undefined && META_TOKEN_INVALID_CODES.has(error.metaCode)
  );
}

const MIN_SECRET_RUN = 8;

/** Replaces every run of 8 or more characters of `secret` found in `text`. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  const whole = text.split(secret).join('[redacted]');
  if (secret.length < MIN_SECRET_RUN) return whole;
  let result = '';
  let i = 0;
  while (i < whole.length) {
    let run = 0;
    while (i + run < whole.length && secret.includes(whole.slice(i, i + run + 1))) run++;
    if (run >= MIN_SECRET_RUN) {
      result += '[redacted]';
      i += run;
    } else {
      result += whole[i];
      i++;
    }
  }
  return result;
}

/**
 * Meta's send error codes and what a caller sees for each (docs/32, AD-004). A refusal Meta names is
 * a 4xx: nothing was sent. Any other code, and a Graph 5xx, is a 502 whose outcome is unknown.
 */
const META_SEND_ERRORS: ReadonlyArray<{ codes: readonly number[]; status: number; code: string }> = [
  { codes: [190, 10, 200, 131005], status: 409, code: 'META_TOKEN_INVALID' },
  { codes: [131047], status: 409, code: 'META_OUTSIDE_SERVICE_WINDOW' },
  { codes: [131048, 131049, 131056], status: 429, code: 'META_LIMIT_REACHED' },
  { codes: [130429], status: 429, code: 'META_RATE_LIMITED' },
  { codes: [131026, 131021], status: 400, code: 'META_RECIPIENT_UNAVAILABLE' },
  { codes: [131008, 131009], status: 400, code: 'META_INVALID_PARAMETER' },
  { codes: [133010, 131031], status: 409, code: 'META_ACCOUNT_RESTRICTED' },
  // F3 door 4: a template Meta does not accept (unknown name or language, wrong parameter count or
  // format, paused or disabled template) is the caller's mistake: 400, and the idempotency key is freed.
  { codes: range(132000, 132016), status: 400, code: 'META_TEMPLATE_INVALID' },
];

const META_RATE_LIMITED_CODE = 130429;

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const REASON: Record<number, string> = { 400: 'Bad Request', 409: 'Conflict', 429: 'Too Many Requests' };

/** The HTTP error a caller sees for a Graph error on a send (the table above). */
export function toSendError(error: MetaGraphError): HttpException {
  const row = META_SEND_ERRORS.find(r => error.metaCode !== undefined && r.codes.includes(error.metaCode));
  const detail = { metaCode: error.metaCode, fbtraceId: error.fbtraceId };
  if (row) {
    return new EngineRejectedSendError({
      statusCode: row.status,
      error: REASON[row.status],
      message: error.message,
      code: row.code,
      ...detail,
    });
  }
  return new BadGatewayException({
    statusCode: 502,
    error: 'Bad Gateway',
    message: error.message,
    code: 'META_UPSTREAM_ERROR',
    ...detail,
  });
}

export interface MetaGraphClientOptions {
  /** Waits between attempts of a `130429` send; its length is the number of retries. */
  retryDelaysMs?: readonly number[];
}

/**
 * The starts reserved per phone number over the last second. A call past `maxRps` in one second is
 * given the earliest start that keeps the window at `maxRps`, and waits for it: delayed, never refused.
 */
class StartWindow {
  private readonly starts = new Map<string, number[]>();

  /** Reserves the next start for `key` and returns how many ms to wait for it. */
  reserve(key: string, maxRps: number, now: number): number {
    const recent = (this.starts.get(key) ?? []).filter(at => at > now - 1000);
    const at = recent.length >= maxRps ? Math.max(now, recent[recent.length - maxRps] + 1000) : now;
    recent.push(at);
    this.starts.set(key, recent);
    return at - now;
  }
}

interface GraphErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
}

export class MetaGraphClient {
  private readonly logger = createLogger('MetaGraphClient');

  private readonly window = new StartWindow();
  private readonly retryDelaysMs: readonly number[];

  constructor(
    private readonly configOf: () => MetaGraphConfig = () => resolveMetaGraphConfig(),
    options: MetaGraphClientOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? META_RATE_LIMIT_RETRY_DELAYS_MS;
  }

  /**
   * A send-side POST for one phone number (a message, a media upload): paced to `maxRps` starts per
   * second for that number, retried on `130429` after each of `retryDelaysMs`, and any Graph error
   * mapped to the HTTP error a caller sees (toSendError). No answer at all stays EngineTransportError.
   */
  async send<T>(phoneNumberId: string, path: string, token: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.paced(phoneNumberId);
      try {
        return await this.request<T>('POST', path, token, body);
      } catch (error) {
        if (!(error instanceof MetaGraphError)) throw error;
        if (error.metaCode === META_RATE_LIMITED_CODE && attempt < this.retryDelaysMs.length) {
          await delay(this.retryDelaysMs[attempt]);
          continue;
        }
        throw toSendError(error);
      }
    }
  }

  private async paced(phoneNumberId: string): Promise<void> {
    const maxRps = this.configOf().maxRps ?? META_CLOUD_MAX_RPS_DEFAULT;
    const wait = this.window.reserve(phoneNumberId, maxRps, Date.now());
    if (wait > 0) await delay(wait);
  }

  /**
   * The bytes behind a media URL Graph handed out (`GET /<MEDIA_ID>` answers it), fetched with the
   * token as Meta requires. Stops reading past `maxBytes` and answers `{ overCapAt }` instead, so a
   * file larger than it declared never lands whole in memory.
   */
  async download(
    url: string,
    token: string,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<{ data: Buffer } | { overCapAt: number }> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new EngineTransportError(`Media download unreachable: ${transportReason(error, timeoutMs)}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new MetaGraphError({
        httpStatus: response.status,
        message: `Media download answered HTTP ${response.status}`,
      });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { overCapAt: total };
      }
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks) };
  }

  /** One Graph call. `body` goes as JSON, or as multipart when it is a FormData. */
  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, body?: unknown): Promise<T> {
    const { baseUrl, version, timeoutMs } = this.configOf();
    const url = `${baseUrl}/${version}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = transportReason(error, timeoutMs);
      this.logger.warn('Graph API request failed before an answer', {
        method,
        path,
        reason,
        action: 'graph_transport',
      });
      throw new EngineTransportError(`Graph API unreachable (${method} ${path}): ${reason}`);
    }

    const text = await response.text().catch(() => '');
    if (response.ok) {
      return (text ? JSON.parse(text) : {}) as T;
    }

    const error = parseGraphError(response.status, text, token);
    this.logger.warn('Graph API answered with an error', {
      method,
      path,
      httpStatus: error.httpStatus,
      metaCode: error.metaCode,
      metaSubcode: error.metaSubcode,
      fbtraceId: error.fbtraceId,
      action: 'graph_error',
    });
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function transportReason(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === 'string') return cause.code;
  return name || 'network error';
}

function parseGraphError(httpStatus: number, text: string, token: string): MetaGraphError {
  let parsed: GraphErrorBody | undefined;
  try {
    parsed = JSON.parse(text) as GraphErrorBody;
  } catch {
    parsed = undefined;
  }
  const e = parsed?.error;
  const metaCode = typeof e?.code === 'number' ? e.code : undefined;
  const raw = typeof e?.message === 'string' ? e.message : `HTTP ${httpStatus}`;
  return new MetaGraphError({
    httpStatus,
    message: `Graph API error${metaCode !== undefined ? ` ${metaCode}` : ''}: ${redactSecret(raw, token)}`,
    metaCode,
    metaSubcode: typeof e?.error_subcode === 'number' ? e.error_subcode : undefined,
    metaType: typeof e?.type === 'string' ? e.type : undefined,
    fbtraceId: typeof e?.fbtrace_id === 'string' ? e.fbtrace_id : undefined,
  });
}
