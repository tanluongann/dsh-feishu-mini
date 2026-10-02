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
  /** A message sent while a turn runs is steered into it (Jeremy's requirement). */
  steerMidTurn: z.boolean().default(true),
  /** Live-card refresh beat, ms. */
  beatMs: z.natural().default(4000),
  /** One line, only when a turn is running. */
  processLine: z.boolean().default(true),
  /** Detail view under the line, opened by the `details` button. */
  processDetail: z.boolean().default(true),
  /**
   * Card dialect. `v1` is the default because schema 2.0 renders as the
   * platform's "please upgrade your client" placeholder on the target client
   * (measured, `scripts/probe-cards.mjs`); v2 also relies on
   * `collapsible_panel`, which is version-gated even inside a v1 card.
   */
  cardVersion: z.union([z.const('v1'), z.const('v2')]).default('v1'),
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
  /** Namespace for the state file and derived session ids (default: appId tail). */
  instance: z.string().default(''),
})

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
