import { ConflictException, Injectable, NotFoundException, NotImplementedException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { MetaCloudAccountStore } from '../../engine/adapters/meta-cloud-account-store.service';
import { MetaGraphClient, MetaGraphError, toSendError } from '../../engine/adapters/meta-cloud-graph.client';
import { META_CLOUD_ENGINE } from '../../engine/session-engine';
import { Session } from '../session/entities/session.entity';
import type { MetaTemplateDto } from './dto/meta-cloud-templates.dto';

/** How long a session's template list is served from memory (F3 door 3). */
export const META_TEMPLATE_CACHE_TTL_MS = 5 * 60_000;
/** The most templates read from Graph for one account. */
export const META_TEMPLATE_LIMIT = 500;

const TEMPLATE_FIELDS = 'name,language,status,category,parameter_format,components';
const PAGE_SIZE = 100;

interface GraphTemplate {
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  parameter_format?: string;
  components?: unknown[];
}

interface GraphTemplatePage {
  data?: GraphTemplate[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** The session row of a `meta-cloud` session: 404 when it does not exist, 501 when it is not a Cloud one. */
export async function requireCloudSession(sessions: Repository<Session>, sessionId: string): Promise<Session> {
  const session = await sessions.findOneBy({ id: sessionId });
  if (!session) throw new NotFoundException(`Session with id '${sessionId}' not found`);
  if (session.engine !== META_CLOUD_ENGINE) {
    throw new NotImplementedException(`Session '${sessionId}' is not a WhatsApp Cloud API session`);
  }
  return session;
}

/**
 * The approved message templates of a `meta-cloud` session's WABA (OpenMsg, docs/32 F3): read from
 * Graph a page at a time, up to 500, and kept in memory per session for 5 minutes. Meta's
 * `components` pass through unchanged.
 */
@Injectable()
export class MetaCloudTemplatesService {
  private readonly logger = createLogger('MetaCloudTemplatesService');
  private readonly graph: MetaGraphClient;
  private readonly cache = new Map<string, { at: number; templates: MetaTemplateDto[] }>();

  constructor(
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    private readonly accounts: MetaCloudAccountStore,
    @Optional() graph?: MetaGraphClient,
  ) {
    this.graph = graph ?? new MetaGraphClient();
  }

  /** The session's templates, from the cache when it is under 5 minutes old and `refresh` is not set. */
  async list(sessionId: string, refresh = false): Promise<MetaTemplateDto[]> {
    await requireCloudSession(this.sessions, sessionId);
    const cached = this.cache.get(sessionId);
    if (!refresh && cached && Date.now() - cached.at < META_TEMPLATE_CACHE_TTL_MS) return cached.templates;

    const templates = await this.fetch(sessionId);
    this.cache.set(sessionId, { at: Date.now(), templates });
    return templates;
  }

  /**
   * The text the customer receives: the template's body with its parameters filled in. Best effort,
   * since Meta is the authority on the template: when the list cannot be read or does not hold the
   * template, the template's name stands in for it and the send goes ahead.
   */
  async renderBody(sessionId: string, input: TemplateSendInput): Promise<string> {
    try {
      const templates = await this.list(sessionId);
      const template = templates.find(t => t.name === input.name && t.language === input.language);
      const body = template?.components.find(
        (c): c is { type: string; text: string } =>
          typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'BODY',
      );
      if (typeof body?.text === 'string') return renderTemplateBody(body.text, input.parameters);
    } catch (error) {
      this.logger.warn('Could not read the template list to render a template send', {
        sessionId,
        template: input.name,
        error: error instanceof Error ? error.message : String(error),
        action: 'meta_template_render_skipped',
      });
    }
    return input.name;
  }

  private async fetch(sessionId: string): Promise<MetaTemplateDto[]> {
    const credentials = await this.accounts.loadCredentials(sessionId);
    if (!credentials?.accessToken) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'The Cloud API session has no usable access token. Set one and restart it.',
        code: 'META_TOKEN_MISSING',
      });
    }
    const templates: MetaTemplateDto[] = [];
    let after: string | undefined;
    do {
      const query = `fields=${TEMPLATE_FIELDS}&limit=${PAGE_SIZE}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      let page: GraphTemplatePage;
      try {
        page = await this.graph.request<GraphTemplatePage>(
          'GET',
          `/${encodeURIComponent(credentials.wabaId)}/message_templates?${query}`,
          credentials.accessToken,
        );
      } catch (error) {
        throw error instanceof MetaGraphError ? toSendError(error) : error;
      }
      const data = page.data ?? [];
      templates.push(...data.map(toTemplate));
      after = data.length && page.paging?.next ? page.paging.cursors?.after : undefined;
    } while (after && templates.length < META_TEMPLATE_LIMIT);
    return templates.slice(0, META_TEMPLATE_LIMIT);
  }
}

/** What a template send names: the template, its language and its body parameters. */
export interface TemplateSendInput {
  name: string;
  language: string;
  parameters?: string[] | Record<string, string>;
}

/** Fills `{{1}}`, `{{2}}`... from an array, or `{{name}}` from an object; an unfilled placeholder stays. */
export function renderTemplateBody(text: string, parameters: TemplateSendInput['parameters']): string {
  if (!parameters) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (placeholder, key: string) => {
    const value = Array.isArray(parameters) ? parameters[Number(key) - 1] : parameters[key];
    return typeof value === 'string' ? value : placeholder;
  });
}

function toTemplate(t: GraphTemplate): MetaTemplateDto {
  return {
    name: t.name ?? '',
    language: t.language ?? '',
    status: t.status ?? '',
    category: t.category ?? '',
    parameterFormat: t.parameter_format ?? 'POSITIONAL',
    components: t.components ?? [],
  };
}
