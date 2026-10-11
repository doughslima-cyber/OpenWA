/**
 * Meta Cloud API Engine Plugin (OpenMsg, docs/32)
 * Built-in engine plugin for sessions bound to a WhatsApp Cloud API number. Registered beside the
 * `ENGINE_TYPE` engine and enabled only when `META_CLOUD_ENABLED=true`; a session uses it when its
 * row's `engine` is `meta-cloud`.
 */

import { PluginContext, PluginType, IEnginePlugin } from '../../../core/plugins';
import { IWhatsAppEngine } from '../../interfaces/whatsapp-engine.interface';
import { MetaCloudAdapter } from '../../adapters/meta-cloud-adapter';
import { META_GRAPH_API_VERSION_DEFAULT } from '../../session-engine';

export class MetaCloudPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;

  onLoad(context: PluginContext): Promise<void> {
    context.logger.log('Meta Cloud API engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('Meta Cloud API engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('Meta Cloud API engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    return new MetaCloudAdapter({
      sessionId: config.sessionId as string,
      dbSessionId: config.dbSessionId as string,
    }).asEngine();
  }

  getFeatures(): string[] {
    return [];
  }

  getEngineLibrary(): { name: string; version: string } {
    return { name: 'whatsapp-cloud-api', version: META_GRAPH_API_VERSION_DEFAULT };
  }

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return Promise.resolve({ healthy: true, message: 'Meta Cloud API engine is available' });
  }
}

export default MetaCloudPlugin;
