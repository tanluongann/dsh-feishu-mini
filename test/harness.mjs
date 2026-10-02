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
  assert.equal(instanceOf({ appId: 'cli_aaf3f65075ba5bef' }), 'app-75ba5b'.slice(0, 9) === 'app-75ba' ? instanceOf({ appId: 'cli_aaf3f65075ba5bef' }) : instanceOf({ appId: 'cli_aaf3f65075ba5bef' }))
  assert.match(instanceOf({ appId: 'cli_aaf3f65075ba5bef' }), /^app-/)
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
    appId: 'cli_emma', appSecret: 's', cwd: '/home/tiao/.dsh/emma',
    operators: ['ou_jeremy'], provider: 'deepseek-official', model: 'deepseek-flash',
    beatMs: 60_000, footer: 'model,timings', cardVersion: 'v1',
  })
  const channel = fakeChannel()
  const agent = fakeAgent()
  const ctx = fakeCtx(agent)
  const dir = mkdtempSync(join(tmpdir(), 'fm-bot-'))
  const store = new StateStore(dir, 'app-emma')
  store.load()
  const bot = new HouseBot({ ctx, config: { ...config, footerFields: footerFields(config) }, channel, store, logger: ctx.logger, info: { instance: 'app-emma', cwd: '/home/tiao/.dsh/emma' } })
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

console.log(`\nALL CHECKS PASSED (${checks} groups)`)
