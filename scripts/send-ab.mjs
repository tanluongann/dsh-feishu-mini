#!/usr/bin/env node
/**
 * A/B/(C) card-version test: send the SAME turn state rendered three ways, so a
 * reader can compare on their own devices.
 *
 *   A  2.0 headerless  — line + tiny stop on the SAME row, native collapsible
 *                        panel, `config.summary` (the chat-list marker)
 *   B  1.0 headerless  — line, action row (stop + details), our own toggle
 *   C  2.0 + header    — A plus a grey one-line header (the other way to get a
 *                        chat-list marker in a world without `summary`)
 *
 * Each is sent live, then patched to its settled state a few seconds later, so
 * both the running and the finished look are visible.
 *
 *   node scripts/send-ab.mjs <chat_id>
 */
import { createLarkChannel } from '@larksuite/channel'
import { Config } from '../lib/config.js'
import { processCard } from '../lib/render.js'
import { foldEvent, initialTurn } from '../lib/turn.js'

const chatId = process.argv[2]
if (chatId === undefined) {
  console.error('usage: node scripts/send-ab.mjs <chat_id>')
  process.exit(2)
}
const appId = process.env.FEISHU_MINI_APP_ID
const appSecret = process.env.FEISHU_MINI_APP_SECRET
if (appId === undefined || appSecret === undefined) {
  console.error('set FEISHU_MINI_APP_ID / FEISHU_MINI_APP_SECRET')
  process.exit(2)
}

const base = Config({
  appId, appSecret, footer: 'model,timings', beatMs: 4000,
})
base.footerFields = []

function stateNow(now) {
  const state = initialTurn()
  foldEvent(state, { type: 'turn/start', data: { turn: 1 } }, now)
  foldEvent(state, { type: 'tool/call', data: { name: 'bash' } }, now + 200)
  foldEvent(state, { type: 'tool/result', data: {} }, now + 3400)
  foldEvent(state, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000 } }, now + 3500)
  return state
}

/** Put the label where the reader will see it. */
function label(card, text, version) {
  const line = `**${text}**`
  if (version === 'v1') {
    card.elements[0].text.content = `${line} · ${card.elements[0].text.content}`
  } else {
    card.body.elements[0].columns[0].elements[0].content = `${line} · ${card.body.elements[0].columns[0].elements[0].content}`
    if (card.header !== undefined) card.header.title.content = text
  }
  return card
}

const variants = [
  { id: 'A', label: 'A · 2.0', version: 'v2', config: { ...base, cardVersion: 'v2' } },
  { id: 'B', label: 'B · 1.0', version: 'v1', config: { ...base, cardVersion: 'v1' } },
  { id: 'C', label: 'C · 2.0 + header', version: 'v2', config: { ...base, cardVersion: 'v2', headerTitle: 'line' } },
]

const channel = createLarkChannel({ appId, appSecret, domain: 0, transport: 'websocket' })
const sent = []

for (const variant of variants) {
  const running = label(processCard(stateNow(Date.now()), variant.config, { sessionId: 'ab-test', cwd: '/tmp' }, Date.now()), variant.label, variant.version)
  const result = await channel.send(chatId, { card: running })
  sent.push({ ...variant, messageId: result.messageId })
  console.log(`sent ${variant.label} → ${result.messageId}`)
  await new Promise((resolve) => setTimeout(resolve, 600))
}

const settleFlag = process.argv.indexOf('--settle-after-ms')
const settleAfter = settleFlag === -1 ? 6000 : Number(process.argv[settleFlag + 1] ?? 6000)
console.log(`\nleaving them in the RUNNING state for ${Math.round(settleAfter / 1000)}s — look now…`)
await new Promise((resolve) => setTimeout(resolve, settleAfter))

for (const entry of sent) {
  const settledState = stateNow(Date.now())
  foldEvent(settledState, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, Date.now() + 4000)
  const settled = label(processCard(settledState, entry.config, { sessionId: 'ab-test', cwd: '/tmp' }, Date.now() + 4000), `${entry.label} · settled`, entry.version)
  try {
    await channel.updateCard(entry.messageId, settled)
    console.log(`patched ${entry.label} → settled (tick, controls gone)`)
  } catch (error) {
    console.log(`FAILED to patch ${entry.label}: ${error?.code ?? ''} ${error?.message ?? error}`)
  }
}

console.log('\nnow read these three in the chat list and in the chat, on BOTH devices:')
for (const entry of sent) console.log(`  ${entry.label} → ${entry.messageId}`)
process.exit(0)
