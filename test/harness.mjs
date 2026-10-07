/**
 * Harness: drives the real render/turn/bot code with fakes.
 * `node test/harness.mjs` — no network, no Feishu app, no DSH session.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, footerFields, instanceOf, resolveCredentials } from '../lib/config.js'
import { answerBody, DETAILS_ACTION, emptyAnswer, processCard, statusCard, STOP_ACTION } from '../lib/render.js'
import { foldEvent, foldStream, formatDuration, initialTurn, statusLine } from '../lib/turn.js'
import { HouseBot } from '../lib/bot.js'
import { channelOptions } from '../lib/lark.js'
import { StateStore } from '../lib/state.js'

let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }

// ------------------------------------------------------------------ config --
{
  const config = Config({ appId: 'cli_x', appSecret: 's', footer: 'model,context', operators: ['ou_a'] })
  assert.equal(config.mode, 'on')
  assert.equal(config.domain, 'feishu')
  assert.equal(config.steerMidTurn, true, 'auto-steer is the default')
  assert.equal(config.reactions.done, 'CheckMark')
  assert.deepEqual(footerFields(config), ['model', 'context'])
  assert.deepEqual(footerFields({ footer: 'off' }), [])
  assert.match(instanceOf({ appId: 'cli_example0001app' }), /^app-/)
  assert.match(instanceOf({ appId: 'cli_example0001app' }), /^app-/)
  assert.deepEqual(
    resolveCredentials({ appId: 'literal', appIdEnv: 'TEST_FH_APP', appSecret: 'literal-secret' }, { TEST_FH_APP: 'from-env' }),
    { appId: 'from-env', appSecret: 'literal-secret' },
    'env name wins over the literal for the app id only',
  )
  assert.equal(Config({ appId: 'a', appSecret: 'b', stopButton: false }).stopButton, false)
  ok('config defaults, footer parsing, instance + credential resolution')
}

// -------------------------------------------------------------------- turn --
{
  const state = initialTurn()
  const t0 = 1_000
  foldEvent(state, { type: 'turn/start', data: { turn: 1 } }, t0)
  assert.equal(state.running, true)
  assert.equal(state.phase, 'thinking')
  foldEvent(state, { type: 'tool/call', data: { name: 'bash', arguments: '{}' } }, t0 + 100)
  assert.equal(state.phase, 'tool')
  assert.match(statusLine(state, t0 + 1_100), /^🔧 bash/)
  foldEvent(state, { type: 'tool/result', data: {} }, t0 + 1_100)
  assert.equal(state.tools.length, 1)
  assert.equal(state.tools[0].ok, true)
  assert.equal(state.phase, 'thinking')
  foldStream(state, { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'weighing options' } }, t0 + 1_200)
  foldStream(state, { type: 'chunk', chunk: { type: 'text-delta', text: 'Hello' } }, t0 + 1_300)
  assert.equal(state.sawReasoning, true)
  assert.equal(state.liveText, 'Hello')
  foldEvent(state, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 100_000 } }, t0 + 1_400)
  foldEvent(state, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello Jeremy' }] }, usage: { inputTokens: 42_000, outputTokens: 380 } } }, t0 + 1_500)
  assert.equal(state.lastText, 'Hello Jeremy')
  assert.equal(state.liveText, '')
  foldEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, t0 + 2_000)
  assert.equal(state.running, false)
  assert.equal(state.phase, 'done')
  assert.match(statusLine(state, t0 + 2_000), /^✅ done/)
  const failed = initialTurn()
  foldEvent(failed, { type: 'turn/start', data: { turn: 2 } }, t0)
  foldEvent(failed, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } } }, t0 + 10)
  assert.equal(failed.phase, 'failed')
  assert.equal(formatDuration(12_400), '12s')
  ok('turn fold: phases, tool rows, deltas, usage, done/failed status lines')
}

// ------------------------------------------------------------------ render --
{
  const config = Config({ appId: 'cli_x', appSecret: 's', footer: 'model,context,tokens,timings' })
  const state = initialTurn()
  const t0 = 1_000
  foldEvent(state, { type: 'turn/start', data: { turn: 1 } }, t0)
  foldEvent(state, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 100_000 } }, t0 + 100)
  foldEvent(state, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Here is the answer.' }] }, usage: { inputTokens: 42_000, outputTokens: 380 } } }, t0 + 500)
  const running = processCard(state, { ...config, footerFields: footerFields(config) }, { sessionId: 's1', cwd: '/tmp' }, t0 + 5_000)
  assert.equal(running.schema, '2.0', 'v2 by default — it carries the same-row stop and the chat-list summary')
  assert.equal(running.header, undefined, 'no header bar')
  assert.equal(running.config.update_multi, true, 'update_multi is required to patch a card')
  assert.match(running.config.summary.content, /^🧠 thinking/, 'the chat list shows the status line')
  assert.equal(running.body.elements[0].tag, 'column_set', 'the line and the stop share one row')
  const stop = running.body.elements[0].columns[1].elements[0]
  assert.equal(stop.tag, 'button')
  assert.equal(stop.size, 'tiny', 'the stop must not be huge')
  assert.equal(stop.behaviors[0].value.action, STOP_ACTION)
  assert.ok(JSON.stringify(running).includes('collapsible_panel'), 'the native panel carries the detail')
  assert.ok(!JSON.stringify(running).includes('"note"'), '2.0 rejects note')

  // v1 remains for clients below 7.20: line, action row, our own toggle
  const v1 = processCard(state, { ...config, cardVersion: 'v1', footerFields: [] }, {}, t0 + 5_100)
  assert.equal(v1.schema, undefined, 'v1 omits the schema field')
  assert.equal(v1.elements[0].tag, 'div')
  const actionRow = v1.elements.at(-1)
  assert.equal(actionRow.tag, 'action', 'v1 needs a top-level action row for buttons')
  assert.match(actionRow.actions[0].text.content, /⏹/)
  assert.equal(actionRow.actions.at(-1).value.action, DETAILS_ACTION, 'v1 uses our own details toggle')
  assert.ok(!JSON.stringify(v1).includes('collapsible_panel'), 'version-gated component stays out of v1')

  // no stop button once the turn is over, and the tick shows up
  foldEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, t0 + 9_000)
  const done = processCard(state, { ...config, footerFields: footerFields(config) }, {}, t0 + 9_500)
  assert.match(done.config.summary.content, /^✅ done/)
  assert.equal(JSON.stringify(done).includes(STOP_ACTION), false, 'button gone when idle')

  // stopButton:false removes it entirely
  const noStop = processCard(state, { ...config, stopButton: false, footerFields: [] }, {}, t0 + 9_600)
  assert.equal(JSON.stringify(noStop).includes(STOP_ACTION), false)

  // details: native panel in v2 (default), our own toggle in v1
  const detailState = initialTurn()
  const v1Config = { ...config, cardVersion: 'v1', footerFields: [] }
  foldEvent(detailState, { type: 'turn/start', data: { turn: 1 } }, t0)
  const bare = processCard(detailState, v1Config, {}, t0)
  assert.equal(JSON.stringify(bare).includes(DETAILS_ACTION), false, 'v1: nothing to show yet — no details button')
  assert.equal(JSON.stringify(bare).includes(STOP_ACTION), true, 'but the stop is there while it runs')
  foldEvent(detailState, { type: 'tool/call', data: { name: 'bash' } }, t0 + 10)
  const collapsed = processCard(detailState, v1Config, {}, t0 + 20)
  assert.equal(JSON.stringify(collapsed).includes(DETAILS_ACTION), true, 'v1: the details button appears with activity')
  const opened = processCard(detailState, v1Config, { detailsOpen: true }, t0 + 30)
  assert.equal(opened.elements.length, 3, 'v1: toggling details adds the detail div')
  assert.match(opened.elements[1].text.content, /🔧 bash/)
  const panel = processCard(detailState, { ...config, footerFields: [] }, {}, t0 + 40)
  assert.ok(JSON.stringify(panel).includes('collapsible_panel'), 'v2: the panel appears once there is activity')

  // the answer is an ordinary message with a small footer, and no dangling rule
  const body = answerBody('Here is the answer.', state, { ...config, footerFields: footerFields(config) }, { sessionId: 's1' })
  assert.match(body, /^Here is the answer\./)
  assert.match(body, /deepseek-flash/, 'model in the footer')
  assert.match(body, /ctx 42%/, 'context share in the footer')
  assert.match(body, /42k in \/ 380 out/, 'token counts in the footer')
  assert.match(body, /9\.0s/, 'elapsed time in the footer')
  assert.equal(body.includes('---'), false, 'no separator line')
  assert.equal(answerBody('plain', state, { ...config, footerFields: [] }, {}), 'plain', 'footer off = clean body')
  const footerLine = answerBody('x', state, { ...config, footerFields: footerFields(config) }, {}).split('\n').at(-1)
  assert.match(footerLine, /^— /, 'the footer starts with a dash, not markdown decoration')
  assert.equal(/[_*`#]/.test(footerLine), false, 'no markdown decoration that the chat list would show raw')
  assert.equal(/^[_*]/.test(emptyAnswer(initialTurn(), t0)), false, 'the empty-turn receipt has no leading underscore')
  assert.match(emptyAnswer(initialTurn(), t0), /no output this turn/)
  assert.match(statusCard(state, { ...config, footerFields: footerFields(config) }, { sessionId: 's1' }, t0).elements[0].text.content, /session/)
  ok('render: headerless v1 card, small stop + details toggle, message answer + footer')
}

// ------------------------------------------------------------------- state --
{
  const dir = mkdtempSync(join(tmpdir(), 'fm-state-'))
  const store = new StateStore(dir, 'app-abc123')
  store.load()
  store.update({ chats: { oc_1: { sessionId: 'fm-app-abc123-1' } } })
  assert.match(store.path, /feishu-mini-app-abc123\.json$/, 'state is namespaced per instance')
  const reread = new StateStore(dir, 'app-abc123')
  reread.load()
  assert.equal(reread.get().chats.oc_1.sessionId, 'fm-app-abc123-1')
  const other = new StateStore(dir, 'app-zzz999')
  other.load()
  assert.equal(Object.keys(other.get().chats).length, 0, 'another instance cannot see this binding')
  rmSync(dir, { recursive: true, force: true })
  ok('state: per-instance file, round trip, isolation')
}

// ----------------------------------------------------------------- the bot --
function fakeChannel() {
  const calls = { sent: [], updated: [], reactions: [], removed: [], connected: 0 }
  const handlers = {}
  return {
    calls,
    handlers,
    on(name, handler) { handlers[name] = handler },
    async connect() { calls.connected += 1 },
    async disconnect() {},
    async send(chatId, input) {
      calls.sent.push({ chatId, input })
      return { messageId: `om_${calls.sent.length}` }
    },
    async updateCard(messageId, card) { calls.updated.push({ messageId, card }) },
    async addReaction(messageId, emoji) { calls.reactions.push({ messageId, emoji }); return 'rx_1' },
    async removeReactionByEmoji(messageId, emoji) { calls.removed.push({ messageId, emoji }); return true },
  }
}

function fakeAgent() {
  const seen = { followup: [], steer: [], cancel: [] }
  return {
    seen,
    status: 'idle',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    followup(message) { seen.followup.push(message); this.status = 'running' },
    steer(message) { seen.steer.push(message) },
    cancel(cause, options) { seen.cancel.push({ cause, options }); this.status = 'idle' },
  }
}

function fakeCtx(agent) {
  const handlers = {}
  return {
    handlers,
    logger: { info: () => {}, warn: () => {} },
    profileContext: { dir: '/tmp', cwd: '/tmp' },
    get(name) {
      if (name !== 'agents') return undefined
      return { get: () => agent, resume: async () => { throw new Error('no session') }, create: async () => ({ agent }) }
    },
    on(name, handler) { handlers[name] = handler; return () => { delete handlers[name] } },
  }
}

{
  const config = Config({
    appId: 'cli_example0001app', appSecret: 's', cwd: '/home/you/.dsh/<agent>',
    operators: ['ou_jeremy'], provider: 'deepseek-official', model: 'deepseek-flash',
    beatMs: 60_000, footer: 'model,timings', cardVersion: 'v1',
  })
  const channel = fakeChannel()
  const agent = fakeAgent()
  const ctx = fakeCtx(agent)
  const dir = mkdtempSync(join(tmpdir(), 'fm-bot-'))
  const store = new StateStore(dir, 'app-emma')
  store.load()
  const bot = new HouseBot({ ctx, config: { ...config, footerFields: footerFields(config) }, channel, store, logger: ctx.logger, info: { instance: 'app-emma', cwd: '/home/you/.dsh/<agent>' } })
  await bot.start()
  assert.equal(channel.calls.connected, 1)
  // The entry point (lib/index.js) wires these two host subscriptions; the
  // harness wires them by hand so no real LarkChannel is constructed.
  ctx.on('session/event', (session, event) => bot.onSessionEvent(session, event))
  ctx.on('agent/assistant-stream', (payload) => bot.onStreamFrame(payload))
  /** Inbound handlers enqueue onto the card chain; settle it before asserting. */
  const settle = () => bot.chain(() => Promise.resolve())

  // 1. a plain message: reaction Typing, dispatched as its own turn
  channel.handlers.message({ messageId: 'om_user1', chatId: 'oc_emma', content: 'hello', senderIsBot: false })
  await settle()
  assert.equal(agent.seen.followup.length, 1, 'dispatched with followup')
  assert.deepEqual(channel.calls.reactions.at(-1), { messageId: 'om_user1', emoji: 'Typing' })
  assert.equal(agent.seen.followup[0].content[0].text, 'hello')

  // 2. a second message while the turn runs: steered, with the thinking reaction
  channel.handlers.message({ messageId: 'om_user2', chatId: 'oc_emma', content: 'also do X', senderIsBot: false })
  await settle()
  assert.equal(agent.seen.steer.length, 1, 'steered into the running turn')
  assert.equal(agent.seen.followup.length, 1, '…and not queued as a new turn')
  assert.equal(channel.calls.removed.at(-1).emoji, 'Typing', 'previous reaction removed')
  assert.equal(channel.calls.reactions.at(-1).emoji, 'THINKING', 'steering shows the thinking emoji')

  // 3. the turn lifecycle: one card, patched in place, then a message answer
  const sessionId = [...bot.chats.values()][0].sessionId
  ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
  await bot.chain(() => Promise.resolve())
  assert.equal(channel.calls.sent.length, 1, 'exactly one card opened')
  const cardMessageId = channel.calls.sent[0].input.card ? 'om_1' : undefined
  assert.ok(cardMessageId, 'the process surface is a card')
  assert.equal(channel.calls.sent[0].input.card.header, undefined, 'headerless')

  ctx.handlers['session/event']({ id: sessionId }, { type: 'tool/call', data: { name: 'bash' } })
  await bot.chain(() => Promise.resolve())
  ctx.handlers['session/event']({ id: sessionId }, { type: 'tool/result', data: {} })
  await bot.chain(() => Promise.resolve())
  assert.ok(channel.calls.updated.length >= 1, 'the card is patched in place while tools run')
  assert.equal(channel.calls.sent.length, 1, 'no extra messages for tool activity')

  ctx.handlers['session/event']({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done: 3 files' }] }, usage: { inputTokens: 20_000, outputTokens: 120 } } })
  ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await bot.chain(() => Promise.resolve())
  const answer = channel.calls.sent.at(-1)
  assert.ok(answer.input.markdown !== undefined, 'the answer is a normal markdown message, not a card')
  assert.match(answer.input.markdown, /^Done: 3 files/)
  assert.match(answer.input.markdown, /deepseek-flash/, 'the footer names the model')
  assert.match(answer.input.markdown, /\d+\.\ds/, 'the footer carries the elapsed time')
  assert.equal(answer.input.markdown.includes('ctx '), false, 'context is not in this footer config')
  assert.equal(channel.calls.reactions.at(-1).emoji, 'CheckMark', 'tick when the turn completes')
  assert.equal(channel.calls.removed.at(-1).emoji, 'THINKING')
  const finalCard = channel.calls.updated.at(-1).card
  assert.match(finalCard.elements[0].text.content, /^✅ done/, 'v1: the line flips to the tick')
  // the details toggle is ours: tapping it patches the card with the detail div
  const beforeToggle = channel.calls.updated.length
  channel.handlers.cardAction({ chatId: 'oc_emma', messageId: 'om_1', action: { value: { action: DETAILS_ACTION } }, operator: { openId: 'ou_jeremy' } })
  await settle()
  assert.ok(channel.calls.updated.length > beforeToggle, 'details toggle re-renders the card')
  assert.match(JSON.stringify(channel.calls.updated.at(-1).card), /🔧 bash/, 'the detail rows are now visible')

  // 4. failure flips the reaction to the cross
  ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/start', data: { turn: 2 } })
  ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } } })
  await bot.chain(() => Promise.resolve())
  assert.equal(channel.calls.reactions.at(-1).emoji, 'CrossMark')

  // 5. the tiny stop button reaches agent.cancel and answers the callback
  const response = channel.handlers.cardAction({ chatId: 'oc_emma', messageId: 'om_1', action: { value: { action: STOP_ACTION, op: 'stop' } }, operator: { openId: 'ou_jeremy' } })
  await bot.chain(() => Promise.resolve())
  assert.equal(agent.seen.cancel.length, 1, 'stop button cancels the turn')
  assert.equal(response.toast.type, 'info')

  // 6. commands do not reach the model
  const before = agent.seen.followup.length
  channel.handlers.message({ messageId: 'om_user3', chatId: 'oc_emma', content: '/display', senderIsBot: false })
  await settle()
  assert.equal(agent.seen.followup.length, before, '/display is handled locally')
  assert.match(channel.calls.sent.at(-1).input.markdown, /footer: model, timings/)

  // 7. bot messages are ignored (no loops)
  const ignored = channel.calls.sent.length
  channel.handlers.message({ messageId: 'om_bot', chatId: 'oc_emma', content: 'hi', senderIsBot: true })
  await settle()
  assert.equal(channel.calls.sent.length, ignored)

  // 8. an oversized answer is segmented instead of being truncated
  const many = 'x'.repeat(9_000)
  await bot.sendMarkdown('oc_emma', many)
  const tail = channel.calls.sent.slice(-3).map((s) => s.input.markdown).join('')
  assert.equal(tail.length, 9_000, 'the whole answer is delivered')
  rmSync(dir, { recursive: true, force: true })
  ok('bot: dispatch, steer, one card per turn, message answer, reactions, stop button, commands, no loops')
}

// ---------------------------------------------------- inbound image handling --
{
  // A 1x1 PNG, valid bytes the attachment store would admit.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  let sniffProbe = undefined // when set, contentType is garbage to exercise the sniff
  const fakeAttachments = {
    saved: { images: [], files: [] },
    async saveImage(input) { this.saved.images.push(input); return { attachmentId: `att-img-${this.saved.images.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name } },
    async saveFile(input) { this.saved.files.push(input); return { attachmentId: `att-file-${this.saved.files.length}`, name: input.name, bytes: input.data.byteLength } },
  }
  const channel = fakeChannel()
  const agent = fakeAgent()
  const ctx = fakeCtx(agent)
  const baseGet = ctx.get.bind(ctx)
  ctx.get = (name) => (name === 'attachments' ? fakeAttachments : baseGet(name))
  let media = { data: png, mediaType: 'image/png' }
  channel.downloadResourceWithMeta = async () => ({ buffer: media.data ?? media.buffer, contentType: media.contentType })
  const config = Config({ appId: 'cli_img', appSecret: 's', cwd: '/home/you/.dsh/<agent>', operators: ['ou_jeremy'], provider: 'deepseek-official', model: 'deepseek-flash', beatMs: 60_000, footer: 'off' })
  const dir = mkdtempSync(join(tmpdir(), 'fm-img-'))
  const store = new StateStore(dir, 'app-img')
  store.load()
  const workdir = mkdtempSync(join(tmpdir(), 'fm-img-work-'))
  const bot = new HouseBot({ ctx, config: { ...config, footerFields: footerFields(config) }, channel, store, logger: ctx.logger, info: { instance: 'app-img', cwd: workdir } })
  await bot.start()
  const settle = () => bot.chain(() => Promise.resolve())
  /** Whatever reached the agent last (followup when idle, steer mid-turn). */
  const lastBlocks = () => agent.seen.steer.at(-1)?.content ?? agent.seen.followup.at(-1)?.content

  // 1. native (default): an image with caption -> text + durable image block
  channel.handlers.message({ messageId: 'im_u1', chatId: 'oc_img', content: 'what is this', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_1' }] })
  await settle()
  let blocks = lastBlocks()
  assert.equal(blocks.length, 2, 'caption + image ride together')
  assert.equal(blocks[0].text, 'what is this')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.mediaType, 'image/png', 'stored as a durable image attachment')
  assert.equal(fakeAttachments.saved.images.length, 1, 'bytes went through the attachment store')

  // 2. an image with no caption still dispatches
  channel.handlers.message({ messageId: 'im_u2', chatId: 'oc_img', content: '', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_2' }] })
  await settle()
  assert.equal(lastBlocks()[0].type, 'image', 'captionless image is not dropped')

  // 3. file mode: the same image becomes a verbatim file block (tool processing)
  bot.config.images = 'file'
  channel.handlers.message({ messageId: 'im_u3', chatId: 'oc_img', content: 'look', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_3', fileName: 'shot.png' }] })
  await settle()
  blocks = lastBlocks()
  assert.equal(blocks[1].type, 'file', 'file mode carries a file block')
  assert.equal(blocks[1].attachment.name, 'shot.png')
  assert.equal(fakeAttachments.saved.files.length, 1, 'stored verbatim, no image admission')

  // 4. off mode: images are dropped, the caption still dispatches
  bot.config.images = 'off'
  channel.handlers.message({ messageId: 'im_u4', chatId: 'oc_img', content: 'text only', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_4' }] })
  await settle()
  blocks = lastBlocks()
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, 'text only')
  bot.config.images = 'native'

  // 5. a broken download degrades to an inline note instead of eating the turn
  media = { get data() { throw new Error('feishu 500') }, mediaType: 'image/png' }
  channel.downloadResourceWithMeta = async () => { throw new Error('feishu 500') }
  channel.handlers.message({ messageId: 'im_u5', chatId: 'oc_img', content: 'again', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_5' }] })
  await settle()
  blocks = lastBlocks()
  assert.equal(blocks.length, 2, 'caption + the failure note reach the model')
  assert.match(blocks[1].text, /could not be fetched/)

  // 5b. a lying content-type (octet-stream) is rescued by magic-byte sniffing
  channel.downloadResourceWithMeta = async () => ({ buffer: png, contentType: 'application/octet-stream' })
  channel.handlers.message({ messageId: 'om_img5b', chatId: 'oc_img', content: 'sniff me', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_5b' }] })
  await settle()
  const sniffed = (agent.seen.steer.at(-1)?.content ?? agent.seen.followup.at(-1)?.content)[1]
  assert.equal(sniffed.type, 'image', 'sniffed image still stored natively')
  assert.equal(sniffed.attachment.mediaType, 'image/png')

  // 6. non-image resources become file blocks when files are on
  channel.downloadResourceWithMeta = async () => ({ buffer: Buffer.from('%PDF-fake'), contentType: 'application/pdf' })
  channel.handlers.message({ messageId: 'im_u6', chatId: 'oc_img', content: 'the doc', senderIsBot: false, resources: [{ type: 'file', fileKey: 'doc_1', fileName: 'spec.pdf' }] })
  await settle()
  blocks = lastBlocks()
  assert.equal(blocks[1].type, 'file')
  assert.equal(blocks[1].attachment.name, 'spec.pdf')

  // 7. no attachment store in the composition: bytes land in the workspace
  ctx.get = (name) => (name === 'attachments' ? undefined : baseGet(name))
  channel.handlers.message({ messageId: 'im_u7', chatId: 'oc_img', content: 'fallback', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_7' }] })
  await settle()
  blocks = lastBlocks()
  assert.match(blocks[1].text, /saved to .*feishu-media/, 'workspace path is named so tools can reach it')

  // 8. inbound batching is off in the SHAPE the SDK reads (`batch.text`) — the
  //    retired flat `batch: { delayMs }` was ignored, which is what let a burst
  //    of images arrive as one message carrying every resource under the last
  //    message's id (Feishu then 400s all but one with `234003 File not in msg`).
  ctx.get = (name) => (name === 'attachments' ? fakeAttachments : baseGet(name))
  const options = channelOptions({ config: Config({ appId: 'cli_img', appSecret: 's' }), credentials: { appId: 'cli_img', appSecret: 's' } })
  assert.equal(options.safety.batch.text.delayMs, 0, 'batch window off in the SDK’s own shape')
  assert.equal(options.safety.batch.delayMs, undefined, 'the ignored flat shape is gone')

  // 9. a merged batch (what the SDK produced before that fix): every resource
  //    but the last is fetched against the wrong message id, so the owner is
  //    recovered from the chat — one listing for the whole burst.
  const owners = { img_b1: 'om_b1', img_b2: 'om_b2' }
  let listings = 0
  let lastListingParams = undefined
  channel.rawClient = { im: { v1: { message: { list: async ({ params }) => {
    listings += 1
    lastListingParams = params
    return { code: 0, data: { items: [
      { message_id: 'om_b1', body: { content: JSON.stringify({ image_key: 'img_b1' }) } },
      { message_id: 'om_b2', body: { content: JSON.stringify({ image_key: 'img_b2' }) } },
    ] } }
  } } } } }
  channel.downloadResourceWithMeta = async (messageId, fileKey) => {
    if (owners[fileKey] !== messageId) throw new Error('Request failed with status code 400')
    return { buffer: png, contentType: 'image/png' }
  }
  channel.handlers.message({
    messageId: 'om_b2', chatId: 'oc_img', createTime: 1_791_367_836_499, senderIsBot: false,
    content: '![image](img_b1)\n\n![image](img_b2)',
    resources: [{ type: 'image', fileKey: 'img_b1' }, { type: 'image', fileKey: 'img_b2' }],
  })
  await settle()
  blocks = lastBlocks()
  assert.equal(blocks.length, 2, 'both images of the batch reach the model (no text block left)')
  assert.equal(blocks[0].type, 'image', 'the earlier message’s image is recovered')
  assert.equal(blocks[1].type, 'image', 'the delivered message’s own image needs no recovery')
  assert.equal(listings, 1, 'one chat listing covers the whole burst')
  assert.equal(lastListingParams.container_id_type, 'chat')
  assert.equal(lastListingParams.container_id, 'oc_img')

  // 9b. an unfetchable key is trusted as a miss for the rest of the burst —
  //     no listing per resource, and the turn still gets an explicit note.
  listings = 0
  channel.rawClient.im.v1.message.list = async () => { listings += 1; return { code: 0, data: { items: [] } } }
  channel.handlers.message({
    messageId: 'om_b3', chatId: 'oc_other', createTime: 1_791_367_900_000, senderIsBot: false,
    content: '![image](img_lost)\n\n![image](img_lost2)',
    resources: [{ type: 'image', fileKey: 'img_lost' }, { type: 'image', fileKey: 'img_lost2' }],
  })
  await settle()
  blocks = lastBlocks()
  assert.equal(blocks.filter((b) => b.type === 'text' && /could not be fetched/.test(b.text)).length, 2, 'both losses are reported')
  assert.equal(blocks.some((b) => /!\[[^\]]*\]\(img_/.test(b.text ?? '')), false, 'the unresolvable markdown link is not left as prose')
  assert.equal(listings, 1, 'the second miss in the same burst does not re-list')

  // 9c. no raw client in the composition: the old single-shot path is kept.
  delete channel.rawClient
  channel.downloadResourceWithMeta = async () => { throw new Error('feishu 400') }
  channel.handlers.message({ messageId: 'om_b4', chatId: 'oc_img', content: 'plain', senderIsBot: false, resources: [{ type: 'image', fileKey: 'img_x' }] })
  await settle()
  assert.match(lastBlocks().at(-1).text, /could not be fetched/, 'degrades to a note without a raw client')

  rmSync(dir, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  ok('bot images: native attachment blocks, file mode, off, broken-download fallback, files, workspace fallback, batched-resource recovery')
}

console.log(`\nALL CHECKS PASSED (${checks} groups)`)
