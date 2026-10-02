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
import { answerBody, emptyAnswer, processCard, statusCard, STOP_ACTION } from './render.js'

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
    return { sessionId: undefined, turn: initialTurn(), cardId: undefined, cardHash: undefined, answerSent: false, reaction: undefined }
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
    if (text === '') return
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
    const userMessage = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const running = agent.status === 'running'
    if (running && this.config.steerMidTurn) {
      agent.steer(userMessage)
      await this.react(message.messageId, this.config.reactions.steered, entry)
      this.logger.info('feishu-mini: steered an inbound message into the running turn')
    } else {
      agent.followup(userMessage)
    }
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
    const info = { ...this.info, sessionId: entry.sessionId }
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

  agentOptions() {
    const provider = this.config.provider === '' ? undefined : this.config.provider
    const model = this.config.model === '' ? undefined : this.config.model
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
    entry.cardId = undefined
    entry.cardHash = undefined
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
