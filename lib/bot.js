/**
 * The bot: Feishu in, DSH session out, one line of progress in between.
 *
 * Owns three things and nothing else:
 *   1. chat ↔ session binding (state keyed per instance, never across agents);
 *   2. the turn lifecycle display (one card, patched in place, hashed);
 *   3. the reaction state machine on the user's own message.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldEvent, foldStream, initialTurn, statusLine } from './turn.js'
import { answerBody, DETAILS_ACTION, emptyAnswer, processCard, statusCard, STOP_ACTION } from './render.js'

/** A resource key as Feishu spells it in message bodies: `img_v3_…` / `file_v3_…`. */
const RESOURCE_KEY = /^(img|file)_[A-Za-z0-9_-]+$/
/**
 * A merged batch lists its messages in one call; a miss inside this window is
 * trusted (one listing per burst), an older cache is refreshed on a miss.
 */
const OWNER_MISS_TRUST_MS = 1_000
/** Chat → owner-map cache bound. */
const OWNER_CACHE_MAX = 64

/**
 * Every resource key inside a raw message `body.content` (a JSON string), at
 * any depth — an image message is `{image_key}`, a file message `{file_key}`,
 * a post nests both inside paragraphs.
 */
function resourceKeysIn(content) {
  if (typeof content !== 'string' || content === '') return []
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const keys = []
  const walk = (value) => {
    if (typeof value === 'string') {
      if (RESOURCE_KEY.test(value)) keys.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value !== null && typeof value === 'object') for (const item of Object.values(value)) walk(item)
  }
  walk(parsed)
  return keys
}

const HELP = [
  '**feishu-mini** — small Feishu surface for DSH',
  '`/status` state + route + counters',
  '`/new` start a fresh session in this chat',
  '`/stop` abort the running turn',
  '`/display` show the display flags',
  'anything else is dispatched to the agent; sending while it works steers the turn',
].join('\n')

export class HouseBot {
  constructor({ ctx, config, channel, store, logger, info = {} }) {
    this.ctx = ctx
    this.config = config
    this.channel = channel
    this.store = store
    this.logger = logger
    this.info = info // { cwd, instance, profile }
    /** chatId → per-chat binding + live turn */
    this.chats = new Map()
    /** chatId → { at, owners: Map(fileKey → messageId) } for batched resources */
    this.ownerCache = new Map()
    this.beatTimer = undefined
    this.disposed = false
    this.queue = Promise.resolve()
  }

  /** Serialize every outbound card/message operation in event order. */
  chain(op) {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  // ------------------------------------------------------------- lifecycle --

  async start() {
    for (const [chatId, saved] of Object.entries(this.store.get().chats ?? {})) {
      this.chats.set(chatId, { ...this.blankChat(), sessionId: saved.sessionId })
    }
    this.channel.on('message', (message) => {
      void this.chain(() => this.onMessage(message)).catch((error) => this.warn('message', error))
    })
    this.channel.on('cardAction', (event) => this.onCardAction(event))
    await this.channel.connect()
    this.beatTimer = setInterval(() => {
      void this.beat().catch((error) => this.warn('beat', error))
    }, this.config.beatMs)
    this.beatTimer.unref?.()
    this.logger.info(`feishu-mini: armed as ${this.info.instance} (cwd ${this.info.cwd})`)
  }

  dispose() {
    this.disposed = true
    if (this.beatTimer !== undefined) clearInterval(this.beatTimer)
    this.beatTimer = undefined
  }

  warn(where, error) {
    this.logger.warn(`feishu-mini: ${where} failed: ${error?.message ?? String(error)}`)
  }

  blankChat() {
    return { sessionId: undefined, turn: initialTurn(), cardId: undefined, cardHash: undefined, answerSent: false, reaction: undefined, detailsOpen: false }
  }

  chat(chatId) {
    let entry = this.chats.get(chatId)
    if (entry === undefined) {
      entry = { ...this.blankChat(), sessionId: this.sessionIdFor(chatId) }
      this.chats.set(chatId, entry)
      // First contact from a chat: record the binding so a restart resumes the
      // same session (and so the instance's state file shows what it serves).
      this.persist()
    }
    return entry
  }

  sessionIdFor(chatId) {
    const tail = chatId.replace(/[^A-Za-z0-9]/g, '').slice(-24)
    return `fm-${this.info.instance}-${tail}`
  }

  persist() {
    const chats = {}
    for (const [chatId, entry] of this.chats) {
      if (entry.sessionId !== undefined) chats[chatId] = { sessionId: entry.sessionId }
    }
    this.store.update({ chats })
  }

  // ---------------------------------------------------------------- inbound --

  async onMessage(message) {
    if (this.disposed) return
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    const resources = Array.isArray(message.resources) ? message.resources : []
    if (text === '' && resources.length === 0) return
    if (message.senderIsBot === true) return

    const entry = this.chat(message.chatId)
    entry.lastUserMessageId = message.messageId

    if (text.startsWith('/')) {
      await this.command(text, message, entry)
      return
    }

    await this.react(message.messageId, this.config.reactions.accepted, entry)
    const agent = await this.ensureAgent(entry)
    if (agent === undefined) {
      await this.reply(message.chatId, '⚠️ no agent service available — nothing was dispatched')
      return
    }
    const content = await this.contentFor(message, text, resources)
    if (content.length === 0) return
    const userMessage = createUserMessage({ content, source: { kind: 'user' } })
    const running = agent.status === 'running'
    if (running && this.config.steerMidTurn) {
      agent.steer(userMessage)
      await this.react(message.messageId, this.config.reactions.steered, entry)
      this.logger.info('feishu-mini: steered an inbound message into the running turn')
    } else {
      agent.followup(userMessage)
    }
  }

  /**
   * Inbound content blocks: the text plus whatever resources arrived with it.
   *
   * Images follow `config.images`: `native` stores the bytes as a durable
   * image attachment and emits an `image` block — vision routes see the pixels
   * natively, text-only routes see the standard placeholder naming the stored
   * path (tool-readable). `file` stores the same bytes as a verbatim file
   * attachment, so the model only gets handle text and deliberately opens the
   * image with a tool. Stickers count as images here (they are pictures the
   * model should simply see). Everything else becomes a `file` block.
   *
   * The text arrives as the SDK's normalised markdown: an image message is
   * literally `![image](img_v3_…)`. Those links are dropped for every resource
   * we handled (the image block carries the pixels; the bare key is noise the
   * model cannot resolve) — and every failure degrades to one explicit text
   * note, because a broken download must never eat the turn.
   */
  async contentFor(message, text, resources) {
    const mode = this.config.images ?? 'native'
    const attachments = this.ctx.get?.('attachments')
    const blocks = []
    const notes = []
    const handled = new Set()
    for (const resource of resources) {
      if (resource === null || typeof resource !== 'object' || typeof resource.fileKey !== 'string') continue
      const isImage = resource.type === 'image' || resource.type === 'sticker'
      if (!isImage && this.config.files !== true) continue
      handled.add(resource.fileKey)
      if (isImage && mode === 'off') continue
      try {
        const kind = isImage && mode === 'native' ? 'image' : 'file'
        const fetched = await this.downloadResource(message, resource)
        // SDK shape: { buffer, contentType } — contentType may carry
        // parameters (`; charset=…`); strip them before MIME checks.
        const data = new Uint8Array(fetched?.buffer ?? Buffer.alloc(0))
        const contentType = typeof fetched?.contentType === 'string' ? fetched.contentType.split(';')[0].trim() : undefined
        if (data.byteLength === 0) throw new Error('empty download')
        if (data.byteLength > this.config.maxResourceBytes) throw new Error(`${data.byteLength} bytes exceeds maxResourceBytes`)
        const name = this.resourceName(resource, contentType)
        if (attachments === undefined) {
          // No attachment store in this composition: keep the bytes readable on
          // disk in the workspace so the agent can still reach them by path.
          const saved = await this.saveWorkspaceFile(name, data)
          notes.push({ type: 'text', text: `[${resource.type} ${name} saved to ${saved}]` })
          continue
        }
        if (kind === 'image') {
          // Feishu sometimes serves a non-image content-type (or none): fall
          // back to a magic-byte sniff of the downloaded bytes.
          const mediaType = this.imageMediaType(contentType) ?? this.sniffMediaType(data)
          if (mediaType === undefined) throw new Error(`unsupported image media type ${contentType ?? 'unknown'}`)
          const ref = await attachments.saveImage({ data, mediaType, name })
          blocks.push({ type: 'image', attachment: ref })
        } else {
          const ref = await attachments.saveFile({ data, name })
          blocks.push({ type: 'file', attachment: ref })
        }
      } catch (error) {
        this.warn(`resource ${resource.fileKey}`, error)
        notes.push({ type: 'text', text: `[${resource.type ?? 'resource'} ${resource.fileName ?? resource.fileKey} could not be fetched: ${error?.message ?? error}]` })
      }
    }
    const prose = this.stripResourceLinks(text, handled)
    if (prose !== '') blocks.unshift({ type: 'text', text: prose })
    blocks.push(...notes)
    return blocks
  }

  /**
   * Download one resource, recovering the message that actually owns it.
   *
   * `downloadResourceWithMeta` needs the owning message id. When the SDK's
   * batch merge produced the message, only the LAST id survives while every
   * message's resources are pooled — so all but the last answer Feishu
   * `234003 File not in msg`. A forwarded card inlines its sub-messages' keys
   * the same way. On any failure we ask the chat which message carries the key
   * (one list call per burst, cached) and retry once with that id.
   */
  async downloadResource(message, resource) {
    const type = resource.type === 'image' ? 'image' : 'file'
    try {
      return await this.channel.downloadResourceWithMeta(message.messageId, resource.fileKey, type)
    } catch (error) {
      const owner = await this.ownerOf(message, resource.fileKey)
      if (owner === undefined || owner === message.messageId) throw error
      this.logger.info?.(`feishu-mini: ${resource.fileKey} belongs to ${owner}, not the delivered ${message.messageId} — retrying against the owner`)
      return await this.channel.downloadResourceWithMeta(owner, resource.fileKey, type)
    }
  }

  /** Cached `fileKey → messageId` lookup, rebuilt from the chat when it misses. */
  async ownerOf(message, fileKey) {
    const cached = this.ownerCache.get(message.chatId)
    if (cached !== undefined) {
      const hit = cached.owners.get(fileKey)
      if (hit !== undefined) return hit
      // A miss right after a listing is a miss for this burst: don't re-list
      // once per unfetchable key.
      if (Date.now() - cached.at < OWNER_MISS_TRUST_MS) return undefined
    }
    const owners = await this.listResourceOwners(message)
    if (owners === undefined) return undefined
    if (this.ownerCache.size >= OWNER_CACHE_MAX) this.ownerCache.clear()
    this.ownerCache.set(message.chatId, { at: Date.now(), owners })
    return owners.get(fileKey)
  }

  /**
   * `im/v1/messages` for this chat around the delivered message's own
   * `createTime` → `Map(fileKey → messageId)`. Read-only, one page, best
   * effort: any failure just means the resource degrades to a note.
   */
  async listResourceOwners(message) {
    const api = this.channel.rawClient?.im?.v1?.message
    if (api === undefined || typeof api.list !== 'function') return undefined
    const at = Number(message.createTime) > 0 ? Number(message.createTime) : Date.now()
    // The API takes seconds and refuses windows wider than 24h; a burst is
    // seconds wide, two minutes of slack covers a slow delivery.
    const start = Math.floor((at - 120_000) / 1000)
    const end = Math.floor((at + 5_000) / 1000)
    try {
      const response = await api.list({
        params: {
          container_id_type: 'chat',
          container_id: message.chatId,
          start_time: String(start),
          end_time: String(end),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
        },
      })
      const owners = new Map()
      for (const item of response?.data?.items ?? []) {
        const messageId = item?.message_id
        if (typeof messageId !== 'string' || messageId === '') continue
        for (const key of resourceKeysIn(item?.body?.content)) if (!owners.has(key)) owners.set(key, messageId)
      }
      return owners
    } catch (error) {
      this.warn(`resource-owner lookup in ${message.chatId}`, error)
      return undefined
    }
  }

  /** Drop `![alt](img_v3_…)` links whose key we already turned into a block. */
  stripResourceLinks(text, keys) {
    if (text === '' || keys.size === 0) return text
    const cleaned = text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (match, key) => (keys.has(key) ? '' : match))
    return cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  /** Sanitized display name: the sender's name, else a synthetic one. */
  resourceName(resource, mediaType) {
    const supplied = typeof resource.fileName === 'string' ? resource.fileName.trim() : ''
    if (supplied !== '') return supplied.replaceAll('/', '_')
    const ext = this.extensionFor(mediaType)
    return `feishu-${String(resource.fileKey).replace(/[^A-Za-z0-9]/g, '').slice(-10) || Date.now().toString(36)}${ext}`
  }

  extensionFor(mediaType) {
    const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' }
    return map[mediaType] ?? ''
  }

  /** Magic-byte sniff for the four raster types the store admits, else undefined. */
  sniffMediaType(data) {
    const b = data
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
    if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
    return undefined
  }

  /** The four raster types the attachment store admits, or undefined. */
  imageMediaType(mediaType) {
    return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType) ? mediaType : undefined
  }

  /** Last-resort byte sink inside the agent workspace (no attachment store). */
  async saveWorkspaceFile(name, data) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(this.info.cwd, 'feishu-media')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${Date.now().toString(36)}-${name}`)
    writeFileSync(path, data)
    return path
  }

  async command(text, message, entry) {
    const [head, ...rest] = text.split(/\s+/)
    switch (head) {
      case '/stop': {
        const agent = await this.ensureAgent(entry)
        try {
          agent?.cancel('user', { keepInbox: true })
          await this.reply(message.chatId, '⏹ stopping')
        } catch (error) {
          await this.reply(message.chatId, `⚠️ could not stop: ${error?.message ?? error}`)
        }
        return
      }
      case '/status': {
        const card = statusCard(entry.turn, this.config, this.statusInfo(entry))
        await this.channel.send(message.chatId, { card })
        return
      }
      case '/new': {
        entry.sessionId = `${this.sessionIdFor(message.chatId)}-${Date.now().toString(36).slice(-4)}`
        entry.turn = initialTurn()
        entry.cardId = undefined
        entry.cardHash = undefined
        this.persist()
        await this.reply(message.chatId, `🆕 new session \`${entry.sessionId}\``)
        return
      }
      case '/display': {
        const fields = this.config.footerFields.join(', ') || 'off'
        await this.reply(message.chatId, [
          `process line: ${this.config.processLine ? 'on' : 'off'}`,
          `details panel: ${this.config.processDetail ? 'on' : 'off'} (${this.config.processRows} rows)`,
          `stop button: ${this.config.stopButton ? 'on' : 'off'}`,
          `answer: ${this.config.answer}`,
          `footer: ${fields}`,
          `reactions: ${Object.values(this.config.reactions).join(' → ')}`,
        ].join('\n'))
        return
      }
      default:
        await this.reply(message.chatId, HELP)
    }
  }

  /**
   * Facts for the footer/status card. The live agent's own route is the most
   * trustworthy source for model/provider (`request/context` may not have been
   * observed yet on a session we attached to mid-flight).
   */
  statusInfo(entry) {
    const info = { ...this.info, sessionId: entry.sessionId, detailsOpen: entry.detailsOpen === true }
    try {
      const live = this.ctx.get('agents')?.get?.(entry.sessionId)
      const agent = live?.agent ?? live
      const options = agent?.options
      if (options !== null && typeof options === 'object') {
        if (typeof options.model === 'string' && options.model !== '') info.model = options.model
        if (typeof options.provider === 'string' && options.provider !== '') info.provider = options.provider
      }
    } catch {
      // a missing agents service must never break a render
    }
    return info
  }

  async ensureAgent(entry) {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return undefined
    const live = agents.get(entry.sessionId)
    const existing = live?.agent ?? live
    if (existing !== undefined && existing !== null) return existing
    const agentOptions = this.agentOptions()
    try {
      const resumed = await agents.resume({
        resumeSessionId: entry.sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      return resumed?.agent ?? resumed
    } catch {
      // no persisted session for this chat yet — fall through to create
    }
    const created = await agents.create({
      sessionId: entry.sessionId,
      meta: { cwd: this.info.cwd },
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
    return created?.agent ?? created
  }

  /**
   * Route for sessions this surface creates. Config first, then the host's
   * default model selection — without a route the created agent fails its first
   * turn ("has no provider/model"), which is exactly what the live probe caught.
   */
  agentOptions() {
    let provider = this.config.provider === '' ? undefined : this.config.provider
    let model = this.config.model === '' ? undefined : this.config.model
    if (provider === undefined || model === undefined) {
      try {
        const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
        if (provider === undefined && typeof selection?.provider === 'string') provider = selection.provider
        if (model === undefined && typeof selection?.model === 'string') model = selection.model
      } catch {
        // no default model service in this composition: keep whatever config gave us
      }
    }
    if (provider === undefined && model === undefined) return undefined
    return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) }
  }

  // ------------------------------------------------------------- host events --

  onSessionEvent(session, event) {
    if (this.disposed) return
    const sessionId = String(session?.id ?? '')
    const entry = this.findBySession(sessionId)
    if (entry === undefined) return
    foldEvent(entry.turn, event, this.now())
    void this.chain(async () => {
      if (event?.type === 'turn/start') {
        entry.answerSent = false
        await this.openCard(entry)
      } else if (event?.type === 'turn/end') {
        await this.finalizeTurn(entry)
      } else if (event?.type === 'tool/call' || event?.type === 'tool/result') {
        await this.patchCard(entry)
      }
    }).catch((error) => this.warn('event', error))
  }

  onStreamFrame(payload) {
    if (this.disposed) return
    const sessionId = String(payload?.agent?.id ?? '')
    const entry = this.findBySession(sessionId)
    if (entry === undefined) return
    if (payload?.frame?.type === 'start') entry.turn.liveText = ''
    foldStream(entry.turn, payload?.frame, this.now())
  }

  findBySession(sessionId) {
    for (const entry of this.chats.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  now() {
    return Date.now()
  }

  // ------------------------------------------------------------ the display --

  cardFor(entry) {
    return processCard(entry.turn, this.config, this.statusInfo(entry), this.now())
  }

  hashOf(card) {
    return JSON.stringify(card)
  }

  async openCard(entry) {
    if (!this.config.processLine) return
    const card = this.cardFor(entry)
    const chatId = this.chatIdOf(entry)
    if (chatId === undefined) return
    const result = await this.channel.send(chatId, { card })
    entry.cardId = result?.messageId ?? result?.chunkIds?.[0]
    entry.cardHash = this.hashOf(card)
  }

  async patchCard(entry) {
    if (entry.cardId === undefined || !this.config.processLine) return
    const card = this.cardFor(entry)
    const hash = this.hashOf(card)
    if (hash === entry.cardHash) return
    entry.cardHash = hash
    await this.channel.updateCard(entry.cardId, card)
  }

  async beat() {
    if (this.disposed) return
    for (const entry of this.chats.values()) {
      if (entry.turn.running) await this.chain(() => this.patchCard(entry))
    }
  }

  chatIdOf(entry) {
    for (const [chatId, value] of this.chats) if (value === entry) return chatId
    return undefined
  }

  async finalizeTurn(entry) {
    const chatId = this.chatIdOf(entry)
    const turn = entry.turn

    // 1. the one-line card: tick / cross, button gone.
    if (entry.cardId !== undefined && this.config.processLine) {
      const card = this.cardFor(entry)
      entry.cardHash = this.hashOf(card)
      await this.channel.updateCard(entry.cardId, card)
    }
    if (chatId === undefined) return

    // 2. the answer: an ordinary message, or embedded in the final card.
    const text = turn.lastText.trim()
    const body = text === '' ? emptyAnswer(turn, this.now()) : answerBody(text, turn, this.config, this.statusInfo(entry))
    if (this.config.answer === 'message') {
      await this.sendMarkdown(chatId, body)
    } else if (this.config.answer === 'card' && entry.cardId !== undefined) {
      const card = processCard(turn, { ...this.config, processDetail: false }, this.statusInfo(entry), this.now())
      card.body.elements.push({ tag: 'markdown', content: body })
      card.config.summary = { content: statusLine(turn, this.now()) }
      await this.channel.updateCard(entry.cardId, card)
    } else if (this.config.answer === 'both') {
      if (entry.cardId !== undefined) {
        const card = processCard(turn, { ...this.config, processDetail: false }, this.statusInfo(entry), this.now())
        card.body.elements.push({ tag: 'markdown', content: body })
        await this.channel.updateCard(entry.cardId, card)
      }
      await this.sendMarkdown(chatId, body)
    }

    // 3. the reaction: done / failed / stopped.
    const reason = turn.endReason?.kind ?? turn.endReason
    const emoji = reason === 'error' ? this.config.reactions.failed
      : reason === 'aborted' ? this.config.reactions.stopped
        : this.config.reactions.done
    if (entry.lastUserMessageId !== undefined) {
      await this.react(entry.lastUserMessageId, emoji, entry)
    }
    // Keep `cardId`: the settled card is the turn's receipt, and the details
    // toggle must still work on it. The next turn opens a new card and
    // overwrites this id; the beat only patches while `turn.running`.
  }

  // ------------------------------------------------------------- outbound --

  async sendMarkdown(chatId, markdown) {
    const limit = this.config.bodySegmentChars
    if (markdown.length <= limit) {
      await this.channel.send(chatId, { markdown })
      return
    }
    // Oversized: the SDK segments plain sends itself, but we keep the answer
    // honest by shipping the first segment in-chat and the rest as one file-less
    // tail message — `send` handles fence-safe chunking per call.
    for (let index = 0; index < markdown.length; index += limit) {
      await this.channel.send(chatId, { markdown: markdown.slice(index, index + limit) })
    }
  }

  async reply(chatId, markdown) {
    try {
      await this.channel.send(chatId, { markdown })
    } catch (error) {
      this.warn('reply', error)
    }
  }

  /** Reaction transitions: Feishu has no replace, so remove the previous one. */
  async react(messageId, emoji, entry) {
    if (typeof emoji !== 'string' || emoji === '') return
    try {
      const previous = entry?.reaction
      if (previous !== undefined && previous !== emoji) {
        await this.channel.removeReactionByEmoji(messageId, previous)
      }
      if (previous !== emoji) await this.channel.addReaction(messageId, emoji)
      if (entry !== undefined) entry.reaction = emoji
    } catch (error) {
      this.warn('react', error)
    }
  }

  // ---------------------------------------------------------- card actions --

  onCardAction(event) {
    if (this.disposed) return undefined
    const value = event?.action?.value
    const action = value !== null && typeof value === 'object' ? value.action : undefined
    if (action === DETAILS_ACTION) {
      const entry = this.chats.get(event.chatId)
      if (entry !== undefined) {
        // Our own "click to expand": the card is patched with the detail div.
        // (`collapsible_panel` is version-gated on the target client, a button
        // + a re-render is not.)
        entry.detailsOpen = !(entry.detailsOpen === true)
        void this.chain(async () => {
          const card = this.cardFor(entry)
          entry.cardHash = this.hashOf(card)
          if (entry.cardId !== undefined) await this.channel.updateCard(entry.cardId, card)
        }).catch((error) => this.warn('details', error))
      }
      return { toast: { type: 'info', content: 'details' } }
    }
    if (action !== STOP_ACTION) return undefined
    void this.chain(async () => {
      const entry = this.chats.get(event.chatId)
      if (entry === undefined) return
      const agent = await this.ensureAgent(entry)
      try {
        agent?.cancel('user', { keepInbox: true })
        entry.turn.phase = 'stopping'
        await this.patchCard(entry)
      } catch (error) {
        this.warn('stop-button', error)
      }
    }).catch((error) => this.warn('cardAction', error))
    return { toast: { type: 'info', content: '⏹ stopping' } }
  }
}
