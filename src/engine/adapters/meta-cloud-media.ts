import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import {
  capInboundMedia,
  coerceDeclaredSize,
  inboundMediaMaxBytes,
  inboundMediaTimeoutMs,
  isMediaDownloadEnabled,
  runUnderGlobalMediaGate,
} from './inbound-media-cap';
import type { MetaGraphClient } from './meta-cloud-graph.client';
import type { CloudMediaRef } from './meta-cloud-inbound.mapper';

type InboundMedia = NonNullable<IncomingMessage['media']>;

/** What `GET /<MEDIA_ID>` answers. */
interface GraphMediaInfo {
  url?: string;
  mime_type?: string;
  file_size?: unknown;
}

/**
 * The media of an inbound Cloud API message (OpenMsg, docs/32): `GET /<MEDIA_ID>` for its URL and
 * size, then the URL, both with the session's token. The existing inbound cap applies: a file Meta
 * declares larger than MEDIA_DOWNLOAD_MAX_BYTES is not fetched at all, and one that turns out larger
 * is dropped mid-stream; both reach the message as the `omitted` marker, as does a failed download.
 * Throws nothing: a message is delivered whether or not its media could be read.
 */
export async function fetchCloudMedia(
  graph: MetaGraphClient,
  token: string | null,
  ref: CloudMediaRef,
): Promise<{ media: InboundMedia; error?: string }> {
  const omitted = (sizeBytes: number): InboundMedia => ({
    mimetype: ref.mimetype,
    ...(ref.filename ? { filename: ref.filename } : {}),
    omitted: true,
    sizeBytes,
  });
  if (!isMediaDownloadEnabled()) return { media: omitted(0) };
  if (!token || !ref.id) return { media: omitted(0), error: token ? 'no media id' : 'no usable access token' };

  try {
    return await runUnderGlobalMediaGate(async () => {
      const info = await graph.request<GraphMediaInfo>('GET', `/${encodeURIComponent(ref.id)}`, token);
      const mimetype = info.mime_type || ref.mimetype;
      const maxBytes = inboundMediaMaxBytes();
      const declared = coerceDeclaredSize(info.file_size);
      const cap = (sizeBytes: number, toBase64: () => string): InboundMedia =>
        capInboundMedia({ mimetype, filename: ref.filename, sizeBytes, toBase64, maxBytes });
      if (declared > maxBytes) return { media: cap(declared, () => '') };
      if (!info.url) return { media: omitted(0), error: 'Graph returned no media URL' };

      const fetched = await graph.download(info.url, token, maxBytes, inboundMediaTimeoutMs());
      if ('overCapAt' in fetched) return { media: cap(fetched.overCapAt, () => '') };
      return { media: cap(fetched.data.length, () => fetched.data.toString('base64')) };
    });
  } catch (error) {
    return { media: omitted(0), error: error instanceof Error ? error.message : String(error) };
  }
}
