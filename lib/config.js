/**
 * Configuration schema and resolution.
 *
 * Schemastery, not zod — and note that a plain `z.string()` is OPTIONAL in this
 * dialect: mandatory keys are marked `.required(true)` (see docs/dsh-plugin-protocol).
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** `off` keeps the row mounted but inert (loader-level disable is `disabled:`). */
  mode: z.union([z.const('on'), z.const('off')]).default('on'),
  /** Feishu (open.feishu.cn) or Lark (open.larksuite.com). */
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  /**
   * Custom-bot webhook URL (`https://open.larksuite.com/open-apis/bot/v2/hook/…`).
   *
   * When set, ANSWERS are delivered by posting to this webhook instead of the app's
   * message API. Why this exists: a Lark/Feishu app can exhaust its monthly call quota
   * (error 99991403) and then it cannot send at all — while inbound events keep
   * arriving over the WebSocket, which is not an API call. A custom bot's webhook is a
   * different endpoint with its own rate limit, so the surface can keep talking in a
   * group that has the bot while the app's quota recovers.
   *
   * Requirements: the webhook belongs to a GROUP chat (custom bots cannot post to a
   * 1:1 chat), and the app itself must be in that group to hear the replies.
   */
  webhookUrl: z.string().default(''),
  /**
   * Connect even when the SDK cannot resolve its own bot identity.
   *
   * The channel SDK fetches its identity from `GET /open-apis/bot/v3/info` as the FIRST
   * step of connecting and treats failure as fatal ("required for channel to function").
   * That endpoint is quota-gated (Lark `99991403`) and can be refused for reasons the
   * app cannot control — a tenant-level bucket, not the app's own budget — which leaves
   * a surface unable to receive anything at all while its sends still work.
   *
   * With this on, a refused identity call is retried once with a placeholder identity.
   * Safe for a 1:1 chat: mention detection is inert (nothing in a DM needs it), and
   * self-echo is decided by the SDK from the raw `sender_type`, not from this id — the
   * plugin additionally ignores `senderIsBot` messages. **Do not enable it for a GROUP
   * surface**: there, the identity is what decides whether the bot was mentioned.
   */
  botIdentityFallback: z.boolean().default(false),
  /**
   * Diagnostic: write every raw `im.message.receive_v1` payload to the event log.
   *
   * Raw handlers run OUTSIDE the channel's safety pipeline (no policy gate, no dedup), so
   * this separates "Lark pushed nothing" from "the channel dropped it locally" — the
   * ambiguity that made the 2026-10-14 outage take an afternoon to pin down. The payload
   * carries full ids and message bodies, so it is off by default and intended for a
   * bounded diagnostic window on a surface you control.
   */
  logRawMessageEvents: z.boolean().default(false),
  /**
   * The channel SDK's own logger level (`debug` | `info` | `warn` | `error`), empty for its
   * default. `debug` is what names the rule when the safety pipeline drops a message
   * silently — the stale window, the dedup cache, the bot-loop guard and the in-flight
   * lock all log there and nowhere else. Diagnostic; leave empty normally.
   */
  logLevel: z.string().default(''),
  /**
   * Deliver inbound messages from the RAW event layer, bypassing the channel's safety
   * pipeline.
   *
   * For a surface whose channel drops every message silently — the case on 2026-10-14,
   * where the SDK's identity call was refused, the channel was connected with a
   * placeholder identity, and messages reached the raw layer and then vanished with no
   * `message` and no `reject` event. The bridge applies the checks that matter here and
   * nothing else: it ignores anything that is not from a user (so the bot can never
   * answer itself), honours `operators` as a sender allowlist, dedups by message id, and
   * takes text only — an image or a file would still need the SDK path, because resource
   * resolution is its job. Every decision is written to the event log.
   */
  rawMessageDelivery: z.boolean().default(false),
  /** Names of env vars holding the credentials — take precedence over literals. */
  appIdEnv: z.string().default(''),
  appSecretEnv: z.string().default(''),
  /** open_id allowlist. Empty = anyone the app is visible to (logged loudly). */
  operators: z.array(String).default([]),
  /** Group chats: only reply when the bot is mentioned. */
  requireMention: z.boolean().default(true),
  /** New sessions are created in this directory (default: the host process cwd). */
  cwd: z.string().default(''),
  /** Route for sessions this surface creates; empty = the host's agent default. */
  provider: z.string().default(''),
  model: z.string().default(''),
  /**
   * Per-channel reasoning-effort override for sessions this surface owns
   * (CHANNEL-CONTRACT §2). Empty = inherit the profile/session default.
   */
  reasoningEffort: z.string().default(''),
  /** A message sent while a turn runs is steered into it (Jeremy's requirement). */
  steerMidTurn: z.boolean().default(true),
  /** Live-card refresh beat, ms. This is the *sampling* interval; see beatClockMs
   * for how often a sample may actually cost an API call. */
  beatMs: z.natural().default(4000),
  /**
   * Hard floor between beat-driven card patches, ms. A card carries elapsed time
   * and streaming text, which change constantly, and stream deltas can even flip a
   * state the fingerprint looks at — so the beat is bounded by *time*, not by what
   * changed: at most one call per chat per this many ms, whatever the state says.
   * Event-driven patches (tool call/result, stop button, details toggle) are not
   * subject to it. 0 = only fingerprint changes ever patch.
   */
  beatMinGapMs: z.natural().default(60_000),
  /**
   * A turn showing no new step and no new tool for this long drops to
   * `stalledBeatMs`, ms (0 = never slow down). One long tool call looks exactly
   * like a hung turn, so this slows the card rather than freezing it.
   */
  stallAfterMs: z.natural().default(30 * 60_000),
  /** Gap applied once a turn looks stalled, ms. Default: one call per 10 minutes. */
  stalledBeatMs: z.natural().default(10 * 60_000),
  /**
   * The live progress card. `false` means no card at all: none is opened and none is
   * patched, which removes the two most frequent calls this plugin makes — the card
   * `POST /im/v1/messages` and a `PATCH /im/v1/messages/:id` per update. Answers
   * still arrive as ordinary messages, and a card answer mode degrades to `message`
   * instead of delivering nothing.
   *
   * Why it exists: a Lark/Feishu app has a monthly API call quota (error 99991403),
   * and the card is what spends it — on 2026-10-14 a 4 s patch loop exhausted one
   * app's quota in a morning. With the card off a turn costs one or two calls
   * instead of dozens, and the per-API quota that gates `PATCH .../messages/:id` and
   * the reaction endpoints is never touched.
   */
  progressCard: z.boolean().default(true),
  /** Legacy alias: `processLine: false` also turns the card off. */
  processLine: z.boolean().default(true),
  /** Detail view under the line, opened by the `details` button. */
  processDetail: z.boolean().default(true),
  /**
   * Card dialect. `v2` is the default: schema 2.0 is what carries the two
   * things v1 cannot — the ⏹ on the SAME row as the status line, and
   * `config.summary` so the chat list shows what the agent is doing. It needs a
   * client >= 7.20; `v1` is the fallback for anything older.
   *
   * Do NOT judge this from the message API: `im/v1/messages/:id` returns a
   * "please upgrade your client" fallback for 2.0 (and panelled) cards whatever
   * the client actually draws. Verified by eye on the target client, 2026-10-02.
   */
  cardVersion: z.union([z.const('v1'), z.const('v2')]).default('v2'),
  /** `line` puts the status line in a v1 header (a title bar) for the chat list. */
  headerTitle: z.union([z.const('off'), z.const('line')]).default('off'),
  /** Tool rows kept in the details panel. */
  processRows: z.natural().default(4),
  /** Tiny ⏹ on the same line as the status. */
  stopButton: z.boolean().default(true),
  /** `message` = the answer is a normal post/md chat message; `card` embeds it. */
  answer: z.union([z.const('message'), z.const('card'), z.const('both')]).default('message'),
  /** Long answers become body cards; this is their segment size. */
  bodySegmentChars: z.natural().default(3500),
  /** Comma list of footer fields, or `off`. Fields: model,provider,effort,context,tokens,cache,timings,tools,session. */
  footer: z.string().default('model,context,tokens,timings'),
  /** Reaction emoji_type names (Feishu catalogue names). */
  reactions: z.object({
    accepted: z.string().default('Typing'),
    steered: z.string().default('THINKING'),
    done: z.string().default('CheckMark'),
    failed: z.string().default('CrossMark'),
    stopped: z.string().default('EYES'),
  }).default({}),
  /**
   * Inbound images: `native` = a durable image attachment in the user message,
   * so a vision-capable route sees pixels natively (and a text-only route gets
   * the standard placeholder text naming the read-only path, which it can
   * still process with tools); `file` = the bytes land as a verbatim file
   * attachment — the model only ever sees handle text and deliberately reads
   * or processes the image with tools; `off` = drop images, text only.
   */
  images: z.union([z.const('native'), z.const('file'), z.const('off')]).default('native'),
  /** Other inbound resources (documents, audio, video) become file attachments. */
  files: z.boolean().default(true),
  /** Refuse to download anything larger than this, per resource. */
  maxResourceBytes: z.natural().default(31_457_280),
  /** Namespace for the state file and derived session ids (default: appId tail). */
  instance: z.string().default(''),
})

/** The live card is on only when neither switch turned it off. */
export function progressCardEnabled(config) {
  return config?.progressCard !== false && config?.processLine !== false
}

/**
 * The answer mode that will actually be delivered.
 *
 * `answer: 'card'` embeds the answer in the live card, so with the card off it would
 * deliver nothing at all; it degrades to a plain message rather than losing a turn's
 * output. (`'both'` keeps its message half, which is the half that always works.)
 */
export function answerMode(config) {
  const mode = typeof config?.answer === 'string' ? config.answer : 'message'
  if (mode === 'message') return 'message'
  return progressCardEnabled(config) ? mode : 'message'
}

/** Resolve env-named credentials first, then literals. */
export function resolveCredentials(config, env = process.env) {
  const pick = (literal, name) => {
    if (typeof name === 'string' && name !== '') {
      const value = env[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return typeof literal === 'string' && literal.trim() !== '' ? literal.trim() : undefined
  }
  return {
    appId: pick(config.appId, config.appIdEnv),
    appSecret: pick(config.appSecret, config.appSecretEnv),
  }
}

/** Stable per-surface namespace: explicit `instance`, else the appId tail. */
export function instanceOf(config) {
  if (typeof config.instance === 'string' && config.instance.trim() !== '') return config.instance.trim()
  const id = typeof config.appId === 'string' ? config.appId : ''
  const tail = id.replace(/[^A-Za-z0-9]/g, '').slice(-6)
  return tail === '' ? 'default' : `app-${tail}`
}

/** Footer field list -> array, or [] for `off`/empty. */
export function footerFields(config) {
  const raw = typeof config.footer === 'string' ? config.footer.trim() : ''
  if (raw === '' || raw === 'off' || raw === 'none') return []
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
}
