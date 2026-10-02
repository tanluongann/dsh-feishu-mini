/**
 * The Feishu side: one `@larksuite/channel` instance per row.
 *
 * Everything protocol-shaped is the SDK's job (WebSocket lifecycle, inbound
 * normalisation and dedup, media, card actions). We only supply policy and the
 * credentials.
 */
import { createLarkChannel } from '@larksuite/channel'

/** `Domain.Feishu = 0`, `Domain.Lark = 1` (node-sdk enum, not re-exported here). */
const DOMAIN = { feishu: 0, lark: 1 }

export function createChannel({ config, credentials }) {
  const policy = {
    requireMention: config.requireMention,
    ...(config.operators.length > 0
      ? { dmMode: 'allowlist', dmAllowlist: [...config.operators] }
      : {}),
  }
  return createLarkChannel({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: DOMAIN[config.domain] ?? DOMAIN.feishu,
    transport: 'websocket',
    policy,
    // The SDK's batch merge stamps the *last* sender's name on everyone's words
    // in a group — the retired plugin disabled it for the same reason.
    safety: { batch: { delayMs: 0 } },
  })
}
