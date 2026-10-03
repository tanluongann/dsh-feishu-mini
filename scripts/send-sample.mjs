#!/usr/bin/env node
/**
 * Send a labelled DISPLAY SAMPLE to a chat, using the production code path
 * (the same builders and the same SDK calls the bot uses) without opening a
 * second WebSocket — outbound only, so it never competes with the running
 * surface for inbound events.
 *
 *   node scripts/send-sample.mjs <chat_id> [appId] [appSecret]
 *
 * Credentials default to the FEISHU_MINI_APP_ID / FEISHU_MINI_APP_SECRET
 * environment variables (a 600 env file sourced by the wrapper).
 */
import { createLarkChannel } from '@larksuite/channel'
import { Config } from '../lib/config.js'
import { answerBody, processCard } from '../lib/render.js'
import { foldEvent, initialTurn } from '../lib/turn.js'

const chatId = process.argv[2]
if (chatId === undefined) {
  console.error('usage: node scripts/send-sample.mjs <chat_id>')
  process.exit(2)
}
const appId = process.argv[3] ?? process.env.FEISHU_MINI_APP_ID
const appSecret = process.argv[4] ?? process.env.FEISHU_MINI_APP_SECRET
if (appId === undefined || appSecret === undefined) {
  console.error('no credentials: pass them or set FEISHU_MINI_APP_ID / FEISHU_MINI_APP_SECRET')
  process.exit(2)
}

const config = Config({
  appId, appSecret,
  footer: 'model,context,tokens,timings',
  processDetail: true,
  stopButton: true,
  beatMs: 4000,
})
config.footerFields = config.footer.split(',').map((s) => s.trim())

const now = Date.now()
const state = initialTurn()
foldEvent(state, { type: 'turn/start', data: { turn: 1 } }, now)
foldEvent(state, { type: 'tool/call', data: { name: 'bash' } }, now + 200)
foldEvent(state, { type: 'tool/result', data: {} }, now + 3400)
foldEvent(state, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000 } }, now + 3500)
foldEvent(state, { type: 'assistant/message', data: {
  message: { content: [{ type: 'text', text: '' }] },
  usage: { inputTokens: 24000, outputTokens: 180 },
} }, now + 4000)

const info = { sessionId: 'fm-app-75ba5b-demo', cwd: '/home/you/.dsh/<agent>' }
const channel = createLarkChannel({ appId, appSecret, domain: 0, transport: 'websocket' })

console.log('sending the live card…')
const live = processCard(state, config, info, now + 5000)
const { messageId } = await channel.send(chatId, { card: live })
console.log('  messageId =', messageId)

// let the reader see the "thinking" state before it settles
await new Promise((resolve) => setTimeout(resolve, 4000))

console.log('settling it in place (tick, button gone)…')
foldEvent(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, now + 9000)
const done = processCard(state, config, info, now + 9000)
await channel.updateCard(messageId, done)

console.log('sending the answer message…')
const answer = [
  'Display sample from **dsh-feishu-mini** — not a real reply.',
  '',
  'The answer is an ordinary chat message, so it renders full markdown:',
  '',
  '| surface | what it is |',
  '| --- | --- |',
  '| process | one headerless card, patched in place |',
  '| answer | a `post` + `md` message like this one |',
  '',
  '```sh',
  'node scripts/send-sample.mjs oc_…   # this sample',
  '```',
].join('\n')
await channel.send(chatId, { markdown: answerBody(answer, state, config, info) })

console.log('rehearsing the reaction state machine on the card…')
await channel.addReaction(messageId, 'Typing')
await new Promise((resolve) => setTimeout(resolve, 1500))
await channel.removeReactionByEmoji(messageId, 'Typing')
await channel.addReaction(messageId, 'CheckMark')

console.log('done — nothing else was sent, and no websocket was opened by this script')
process.exit(0)
