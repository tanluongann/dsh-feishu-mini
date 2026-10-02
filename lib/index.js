/**
 * Cordis entry — the object-plugin shape the loader accepts:
 * `{ name, inject, Config, apply(ctx, config) }`.
 *
 * Design rule: this file and `bot.js` are the only DSH-aware code. If the host
 * renames a service, an event or a payload field, the damage is contained here
 * and reported as one log line instead of a half-alive bot.
 */
import { Config, footerFields, instanceOf, resolveCredentials } from './config.js'
import { createChannel } from './lark.js'
import { HouseBot } from './bot.js'
import { StateStore } from './state.js'

export const name = 'feishu-mini'
/** The one seam we cannot work without; everything else is feature-detected. */
export const inject = ['agents']
export { Config }

/**
 * @param ctx - cordis context
 * @param config - schema-resolved config
 * @param deps - test seam: `{ createChannel }` may be injected so the entry can
 *   be exercised without opening a real Feishu connection. The loader never
 *   passes it (cordis forwards only the outer stack as a third argument), so
 *   tests wrap this plugin instead — see test/integration.mjs.
 */
export function apply(ctx, config, deps = {}) {
  const log = ctx.logger ?? console
  if (config.mode === 'off') {
    log.info?.('feishu-mini: mode off — row mounted but inert')
    return
  }
  const credentials = resolveCredentials(config)
  if (credentials.appId === undefined || credentials.appSecret === undefined) {
    log.warn?.('feishu-mini: no credentials (appId/appSecret or the env names) — dormant, nothing connected')
    return
  }

  const profile = ctx.profileContext ?? ctx.get?.('profileContext') ?? {}
  const directory = typeof profile.dir === 'string' && profile.dir !== '' ? profile.dir : process.cwd()
  const cwd = config.cwd !== '' ? config.cwd : (typeof profile.cwd === 'string' && profile.cwd !== '' ? profile.cwd : process.cwd())
  // Namespace from the RESOLVED app id: with credentials supplied by env name
  // (`appIdEnv`), `config.appId` is empty here, and two rows in one profile
  // would otherwise both land on the same namespace and the same session ids.
  const instance = instanceOf({ ...config, appId: credentials.appId ?? config.appId })

  // Footer is parsed once: the config object here is already schema-resolved.
  const resolved = { ...config, footerFields: footerFields(config) }

  const store = new StateStore(directory, instance)
  store.load()

  const channel = (deps.createChannel ?? createChannel)({ config: resolved, credentials })
  const bot = new HouseBot({
    ctx,
    config: resolved,
    channel,
    store,
    logger: log,
    info: { instance, cwd, directory },
  })

  if (config.operators.length === 0) {
    log.warn?.('feishu-mini: no operators configured — anyone the app is visible to may drive this surface')
  }

  // Body runs immediately; the returned function is the disposer.
  ctx.effect(() => {
    void bot.start().catch((error) => {
      log.warn?.(`feishu-mini: start failed: ${error?.message ?? String(error)}`)
    })
    return () => {
      bot.dispose()
      void channel.disconnect?.().catch?.(() => undefined)
    }
  })

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        bot.onSessionEvent(session, event)
      } catch (error) {
        log.warn?.(`feishu-mini: event fold failed: ${error?.message ?? String(error)}`)
      }
    })
    const offStream = ctx.on('agent/assistant-stream', (payload) => {
      try {
        bot.onStreamFrame(payload)
      } catch (error) {
        log.warn?.(`feishu-mini: stream fold failed: ${error?.message ?? String(error)}`)
      }
    })
    return () => {
      offEvent?.()
      offStream?.()
    }
  })

  log.info?.(`feishu-mini: row active (instance ${instance}, domain ${config.domain}, cwd ${cwd})`)
}
