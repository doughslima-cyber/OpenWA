import type { AdapterCapability } from './engine-capability-matrix';

/**
 * OpenMsg (docs/32 D6, phase F2): the `cloud` column of the engine capability matrix, the WhatsApp
 * Cloud API adapter (`adapters/meta-cloud-*`). Kept in its own file so the upstream matrix carries
 * one hook line per derived row.
 *
 * Unlike the QR engines, where supported is the default, most interface methods have no Cloud API
 * counterpart, so the column is written the other way round: the methods below are supported and
 * every other one is `not-available` and rejects with EngineNotSupportedError (501).
 * `engine-parity.spec.ts` holds the adapter to this column in both directions.
 */
export const CLOUD_SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  // Session and connection: no QR and no pairing code; getQRCode always answers null.
  'initialize',
  'disconnect',
  'logout',
  'destroy',
  'forceDestroy',
  'getStatus',
  'probeLiveness',
  'getQRCode',
  'getPhoneNumber',
  'getPushName',
  // Sending: media goes by uploaded id, a voice note as `audio`, a reply through `context`.
  'sendTextMessage',
  'sendImageMessage',
  'sendVideoMessage',
  'sendAudioMessage',
  'sendDocumentMessage',
  'sendStickerMessage',
  'sendLocationMessage',
  'sendContactMessage',
  'replyToMessage',
  'reactToMessage',
  // Read side, served from the gateway's own tables (`messages`, `meta_cloud_contacts`).
  'getChats',
  'getChatHistory',
  'getContactById',
  'resolveContactPhone',
  'sendSeen',
  'sendChatState',
]);

/**
 * Not-available cells whose operation the Cloud API does offer, so wiring is work in this repo
 * (`adapter-gap`): the profile and block-list methods are doc 32 F5, the two catalog sends need
 * `interactive` messages (F4). Every other not-available cell has no Cloud API operation at all.
 */
const CLOUD_ADAPTER_GAPS: ReadonlySet<string> = new Set([
  'setProfileStatus',
  'setProfilePicture',
  'deleteProfilePicture',
  'blockContact',
  'unblockContact',
  'getBlockedContacts',
  'sendProduct',
  'sendCatalog',
]);

/** The `cloud` cell of one interface method. */
export function cloudCapability(method: string): AdapterCapability {
  if (CLOUD_SUPPORTED_METHODS.has(method)) return { status: 'supported' };
  return {
    status: 'not-available',
    rootCause: CLOUD_ADAPTER_GAPS.has(method) ? 'adapter-gap' : 'library-limitation',
  };
}
