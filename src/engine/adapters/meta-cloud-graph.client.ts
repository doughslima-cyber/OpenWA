import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';
import { META_GRAPH_API_VERSION_DEFAULT } from '../session-engine';

/**
 * The HTTP client a `meta-cloud` session talks to Graph through (OpenMsg, docs/32).
 *
 * Native `fetch` with a per-call timeout. A call that never got an answer (refused, reset, timed
 * out) raises EngineTransportError (503); an answer that is not 2xx raises MetaGraphError carrying
 * Meta's error fields. The token travels only in the Authorization header: no log line and no error
 * message built here carries it, and Meta's own `message` is scrubbed of it before it is kept.
 */

export const META_GRAPH_BASE_URL_DEFAULT = 'https://graph.facebook.com';
export const META_CLOUD_TIMEOUT_MS_DEFAULT = 15_000;

/** Graph error codes that mean the token is expired, revoked or lacks the permission. */
export const META_TOKEN_INVALID_CODES: ReadonlySet<number> = new Set([190, 10, 200]);

export interface MetaGraphConfig {
  baseUrl: string;
  version: string;
  timeoutMs: number;
}

/** Read at call time, like the other Cloud API settings, so a test can point it at a fake Graph. */
export function resolveMetaGraphConfig(env: NodeJS.ProcessEnv = process.env): MetaGraphConfig {
  const timeout = Number.parseInt(env.META_CLOUD_TIMEOUT_MS ?? '', 10);
  return {
    baseUrl: (env.META_GRAPH_BASE_URL || META_GRAPH_BASE_URL_DEFAULT).replace(/\/+$/, ''),
    version: env.META_GRAPH_API_VERSION || META_GRAPH_API_VERSION_DEFAULT,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : META_CLOUD_TIMEOUT_MS_DEFAULT,
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

interface GraphErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
}

export class MetaGraphClient {
  private readonly logger = createLogger('MetaGraphClient');

  constructor(private readonly configOf: () => MetaGraphConfig = () => resolveMetaGraphConfig()) {}

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, body?: unknown): Promise<T> {
    const { baseUrl, version, timeoutMs } = this.configOf();
    const url = `${baseUrl}/${version}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
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
