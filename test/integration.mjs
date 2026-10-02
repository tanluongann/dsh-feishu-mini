/**
 * Integration test: boot the REAL cordis entry through the REAL registry — real
 * config validation, real `inject` resolution, real fiber + effect lifecycle,
 * real context event emission — with only the Feishu connection replaced by a
 * fake (the `deps.createChannel` seam).
 *
 * This is the test the unit harness cannot be: it proves the plugin is wired the
 * way DSH loads it, and that disposal actually tears the surface down.
 *
 * `node test/integration.mjs` — no network, no Feishu app, no model call.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { footerFields } from '../lib/config.js'

let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

function fakeChannel() {
  const state = { sent: [], updated: [], reactions: [], removed: [], connects: 0, disconnects: 0, handlers: {} }
  return {
    state,
    on(name, handler) { state.handlers[name] = handler },
    async connect() { state.connects += 1 },
    async disconnect() { state.disconnects += 1 },
    async send(chatId, input) { state.sent.push({ chatId, input }); return { messageId: `om_${state.sent.length}` } },
    async updateCard(messageId, card) { state.updated.push({ messageId, card }) },
    async addReaction(messageId, emoji) { state.reactions.push({ messageId, emoji }); return 'rx' },
    async removeReactionByEmoji(messageId, emoji) { state.removed.push({ messageId, emoji }); return true },
  }
}

function fakeAgents() {
  const agent = {
    status: 'idle',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    seen: { followup: [], steer: [], cancel: [] },
    followup(message) { this.seen.followup.push(message); this.status = 'running' },
    steer(message) { this.seen.steer.push(message) },
    cancel(cause, options) { this.seen.cancel.push({ cause, options }); this.status = 'idle' },
  }
  return { agent, service: { get: () => agent, list: () => [agent], resume: async () => { throw new Error('none') }, create: async () => ({ agent }) } }
}

/** Wrap the plugin so the fake channel is injected without touching lib/. */
function wrapperFor(channel) {
  return {
    name: 'feishu-mini-under-test',
    inject: plugin.inject,
    Config: plugin.Config,
    apply: (ctx, config) => plugin.apply(ctx, config, { createChannel: () => channel }),
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'fm-integration-'))

// ------------------------------------------------ arm through the real fiber --
{
  const ctx = new Context()
  const { agent, service } = fakeAgents()
  ctx.provide('agents', service)
  // profileContext is provided by the host; mimic it so state lands in a temp dir
  ctx.provide('profileContext', { dir: workdir, cwd: workdir, name: 'test' })

  const channel = fakeChannel()
  const fork = ctx.plugin(wrapperFor(channel), {
    appId: 'cli_integration', appSecret: 'secret', cwd: workdir,
    footer: 'model,timings', beatMs: 50, provider: 'deepseek-official', model: 'deepseek-flash',
  })
  await fork
  assert.equal(fork.state, 2, 'fiber must reach ACTIVE (2)')
  assert.equal(channel.state.connects, 1, 'the surface connected once')
  ok('plugin arms through the real registry: ACTIVE, config validated, channel connected')

  // ------------------------------------------------------------ inbound --
  channel.state.handlers.message({ messageId: 'om_1', chatId: 'oc_test', content: 'hello there', senderIsBot: false })
  await settle()
  assert.equal(agent.seen.followup.length, 1, 'a plain message becomes a turn')
  assert.equal(channel.state.reactions.at(-1).emoji, 'Typing', 'accepted-reaction on the user message')
  ok('inbound: reaction first, then the turn')

  // ------------------------------------------------- a real turn lifecycle --
  // The bot derives the session id from the chat; read it back from the state
  // file it persisted, which is also how we prove per-instance state landed.
  const { readFileSync } = await import('node:fs')
  const stateFiles = (await import('node:fs')).readdirSync(workdir).filter((f) => f.startsWith('feishu-mini-'))
  assert.equal(stateFiles.length, 1, 'per-instance state file written on first contact')
  const persisted = JSON.parse(readFileSync(join(workdir, stateFiles[0]), 'utf8'))
  const boundId = persisted.chats.oc_test.sessionId
  assert.match(boundId, /^fm-/, 'session ids are namespaced by instance')

  ctx.emit('session/event', { id: boundId }, { type: 'turn/start', data: { turn: 1 } })
  await settle()
  assert.equal(channel.state.sent.length, 1, 'one card opened for the turn')
  const card = channel.state.sent[0].input.card
  assert.equal(card.schema, undefined, 'v1 card by default (the client rejects 2.0 bodies)')
  assert.equal(card.header, undefined, 'headerless')
  assert.match(card.elements[0].text.content, /^🧠 thinking/)

  ctx.emit('session/event', { id: boundId }, { type: 'tool/call', data: { turn: 1, step: 1, name: 'bash' } })
  ctx.emit('session/event', { id: boundId }, { type: 'tool/result', data: { turn: 1, step: 1 } })
  await settle()
  assert.ok(channel.state.updated.length >= 1, 'tool activity patches the same card')
  assert.equal(channel.state.sent.length, 1, 'tool activity never opens a new message')

  ctx.emit('agent/assistant-stream', { agent: { id: boundId }, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  ctx.emit('agent/assistant-stream', { agent: { id: boundId }, frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking about it' } } })
  await settle()
  assert.match(channel.state.updated.at(-1).card.elements[0].text.content, /🔧|🧠/, 'stream deltas reach the live card')

  ctx.emit('session/event', { id: boundId }, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 100000 } })
  ctx.emit('session/event', { id: boundId }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Done — 3 files changed.' }] }, usage: { inputTokens: 20000, outputTokens: 120 } },
  })
  ctx.emit('session/event', { id: boundId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  const answer = channel.state.sent.at(-1).input
  assert.ok(answer.markdown !== undefined, 'the answer is an ordinary markdown message')
  assert.match(answer.markdown, /^Done — 3 files changed\./)
  assert.match(answer.markdown, /deepseek-flash/, 'footer carries the model from the live agent')
  assert.equal(answer.markdown.includes('---'), false, 'no separator line')
  assert.equal(channel.state.reactions.at(-1).emoji, 'CheckMark', 'tick once the turn completes')
  assert.match(channel.state.updated.at(-1).card.elements[0].text.content, /^✅ done/, 'the line flips to the tick')
  ok('turn lifecycle: one card, patched in place → message answer + footer → tick')

  // --------------------------------------------------- the details toggle --
  {
    const before = channel.state.updated.length
    const response = channel.state.handlers.cardAction({ chatId: 'oc_test', messageId: 'om_1', action: { value: { action: 'feishu-mini/details' } }, operator: { openId: 'ou_x' } })
    await settle()
    assert.ok(channel.state.updated.length > before, 'the details toggle patches the card')
    assert.match(JSON.stringify(channel.state.updated.at(-1).card), /🔧/, 'detail rows now render')
    assert.equal(response.toast.type, 'info')
    // and back again
    channel.state.handlers.cardAction({ chatId: 'oc_test', messageId: 'om_1', action: { value: { action: 'feishu-mini/details' } }, operator: { openId: 'ou_x' } })
    await settle()
    ok('details toggle: click to expand, click to hide — no version-gated panel')
  }

  // ------------------------------------------------------- the beat timer --
  const before = channel.state.updated.length
  ctx.emit('session/event', { id: boundId }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  ctx.emit('agent/assistant-stream', { agent: { id: boundId }, frame: { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'writing…' } } })
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(channel.state.updated.length > before, 'the beat refreshes the live card')
  ok('beat: live card refreshed on its own cadence')

  // ------------------------------------------------------------- dispose --
  await fork.dispose()
  assert.notEqual(fork.state, 2, 'fiber left ACTIVE on dispose')
  assert.equal(channel.state.disconnects, 1, 'the channel was disconnected')
  const reactionsAfterDispose = channel.state.reactions.length
  ctx.emit('session/event', { id: boundId }, { type: 'turn/start', data: { turn: 3 } })
  await settle()
  assert.equal(channel.state.reactions.length, reactionsAfterDispose, 'a disposed surface ignores events')
  ok('dispose: fiber torn down, channel disconnected, events ignored')
}

// -------------------------------------------------- the dormant credential --
{
  const ctx = new Context()
  const { service } = fakeAgents()
  ctx.provide('agents', service)
  ctx.provide('profileContext', { dir: workdir, cwd: workdir })
  let constructed = 0
  const fork = ctx.plugin({
    name: 'feishu-mini-dormant',
    inject: plugin.inject,
    Config: plugin.Config,
    apply: (ctx2, config) => plugin.apply(ctx2, config, { createChannel: () => { constructed += 1; return fakeChannel() } }),
  }, { appId: '', appSecret: '' })
  await fork
  assert.equal(fork.state, 2, 'no credentials must not fail the tree')
  assert.equal(constructed, 0, 'and must not open a connection')
  await fork.dispose()
  ok('no credentials: row active but dormant, nothing connected')
}

// ---------------------------------------------- invalid config still fails --
{
  const ctx = new Context()
  ctx.provide('agents', fakeAgents().service)
  ctx.provide('profileContext', { dir: workdir, cwd: workdir })
  let threw = false
  try {
    const fork = ctx.plugin(wrapperFor(fakeChannel()), { beatMs: 'soon' })
    await fork
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'a bad config must be rejected by schemastery')
  ok('invalid config: rejected (beatMs must be a natural)')
}

rmSync(workdir, { recursive: true, force: true })
console.log(`\nALL INTEGRATION CHECKS PASSED (${checks} groups)`)
assert.ok(footerFields({ footer: 'off' }).length === 0)
