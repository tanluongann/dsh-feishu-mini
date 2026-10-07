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

/**
 * Options for one channel instance. Split out of {@link createChannel} so the
 * shape can be asserted in the harness without opening a socket.
 */
export function channelOptions({ config, credentials }) {
  const policy = {
    requireMention: config.requireMention,
    ...(config.operators.length > 0
      ? { dmMode: 'allowlist', dmAllowlist: [...config.operators] }
      : {}),
  }
  return {
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: DOMAIN[config.domain] ?? DOMAIN.feishu,
    transport: 'websocket',
    policy,
    // Inbound batching OFF. The SDK reads `batch.text` (0.7.x); the older flat
    // `batch: { delayMs: 0 }` shape we shipped was silently ignored, so the
    // 600 ms merge window stayed on and a burst of messages arrived as ONE
    // NormalizedMessage. Two things break when that happens:
    //   - the merge keeps only the LAST message's id while pooling every
    //     message's resources (`mergeBatch`), so all but one download 400s with
    //     `234003 File not in msg` — Nelly lost 4 of 5 dinner photos that way
    //     (2026-10-07);
    //   - the merged message carries the last sender's name for everyone's
    //     words, which is why the retired plugin disabled batching.
    // bot.js still recovers the owning message id when a merge does happen
    // (forwarded cards, a future SDK default flip) — belt and braces.
    safety: { batch: { text: { delayMs: 0 } } },
  }
}

export function createChannel({ config, credentials }) {
  return createLarkChannel(channelOptions({ config, credentials }))
}
