/**
 * Which engine a session runs (OpenMsg, docs/32 D1).
 *
 * `sessions.engine` is NULL for every session that follows the deployment's `ENGINE_TYPE`; the only
 * value ever written is `meta-cloud`. The Cloud API engine is a plugin enabled beside the
 * `ENGINE_TYPE` one, and only while `META_CLOUD_ENABLED=true`.
 */

/** Plugin id and the value persisted in `sessions.engine` for a WhatsApp Cloud API session. */
export const META_CLOUD_ENGINE = 'meta-cloud';

/** Graph API version used until `META_GRAPH_API_VERSION` overrides it. */
export const META_GRAPH_API_VERSION_DEFAULT = 'v26.0';

/**
 * Whether Cloud API sessions are switched on. Read at call time, like the other `=== 'true'` flags,
 * so a blank compose forward (cleared by env-precedence) reads as off.
 */
export function isMetaCloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.META_CLOUD_ENABLED === 'true';
}

/** The deployment engine, resolved exactly as `configuration.ts` resolves `engine.type`. */
export function deploymentEngineType(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGINE_TYPE || 'whatsapp-web.js';
}

/** The engine a session row runs: its own `engine`, or the deployment's when the row has none. */
export function sessionEngineOf(row: { engine?: string | null }, env: NodeJS.ProcessEnv = process.env): string {
  return row.engine ?? deploymentEngineType(env);
}
