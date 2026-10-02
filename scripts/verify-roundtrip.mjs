#!/usr/bin/env node
/**
 * Verify one real Feishu round trip, from outside the process.
 *
 * Run it after DMing the pilot bot: it inspects the instance's state file, the
 * session store, and the chat's own history (messages + reactions) through the
 * API, and prints PASS/FAIL per claim.
 *
 *   node scripts/verify-roundtrip.mjs <chat_id> [--profile emma] [--state-dir ~/.dsh/profiles/emma]
 *                                                       [--sessions ~/.dsh/sessions]
 *
 * Credentials: FEISHU_MINI_APP_ID / FEISHU_MINI_APP_SECRET (a 600 env file).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLarkChannel } from '@larksuite/channel'

const chatId = process.argv[2]
if (chatId === undefined || chatId.startsWith('--')) {
  console.error('usage: node scripts/verify-roundtrip.mjs <chat_id> [--state-dir <dir>] [--sessions <dir>]')
  process.exit(2)
}
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const stateDir = flag('--state-dir', join(homedir(), '.dsh', 'profiles', 'emma'))
const sessionsDir = flag('--sessions', join(homedir(), '.dsh', 'sessions'))

const appId = process.env.FEISHU_MINI_APP_ID
const appSecret = process.env.FEISHU_MINI_APP_SECRET
if (appId === undefined || appSecret === undefined) {
  console.error('set FEISHU_MINI_APP_ID / FEISHU_MINI_APP_SECRET (e.g. `. ~/.config/dsh-emma.env`)')
  process.exit(2)
}

const results = []
const claim = (ok, label, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- local state --
let bound
const stateFiles = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.startsWith('feishu-mini-')) : []
claim(stateFiles.length >= 1, 'the instance has a state file (a chat has been bound)',
  stateFiles.join(', ') || `none in ${stateDir}`)
if (stateFiles.length >= 1) {
  const state = JSON.parse(readFileSync(join(stateDir, stateFiles[0]), 'utf8'))
  bound = state.chats?.[chatId]?.sessionId
  claim(bound !== undefined, 'the state file binds THIS chat to a session', bound ?? Object.keys(state.chats ?? {}).join(', '))
}
if (bound !== undefined) {
  const roots = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((d) => d.includes('emma')) : []
  const found = roots.some((root) => existsSync(join(sessionsDir, root, bound)))
  claim(found, 'the DSH session store holds that session', `${bound} in ${roots.join(', ')}`)
}

// ------------------------------------------------------------------ chat side --
const channel = createLarkChannel({ appId, appSecret, domain: 0, transport: 'websocket' })
const client = channel.rawClient

const listing = await client.im.v1.message.list({
  params: { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: 20 },
})
const items = listing?.data?.items ?? []
const cards = []
const answers = []
const inbound = []
for (const item of items) {
  let body = {}
  try { body = JSON.parse(item.body?.content ?? '{}') } catch { /* not JSON */ }
  if (item.msg_type === 'interactive') cards.push({ item, body })
  else if (item.msg_type === 'post' || item.msg_type === 'text') {
    const isBot = item.sender?.sender_type === 'app'
    const text = JSON.stringify(body)
    if (isBot) answers.push({ item, text })
    else inbound.push({ item, text })
  }
}

claim(cards.length >= 1, 'a process card reached the chat', `${cards.length} card message(s)`)
claim(inbound.length >= 1, 'the human message is in the chat', `${inbound.length} inbound message(s)`)
claim(answers.length >= 1, 'an answer message reached the chat', `${answers.length} bot message(s)`)
if (cards.length >= 1) {
  const newest = cards[0]
  const flat = JSON.stringify(newest.body)
  claim(!flat.includes('请升级'), 'the newest card rendered (no "upgrade your client" placeholder)')
  const stateLine = /(🧠|🔧|✍️|✅|⚠️|⏹)[^"]*/u.exec(flat)?.[0] ?? ''
  claim(/(🧠|🔧|✍️|✅|⚠️|⏹)/u.test(flat), 'the one-line status survived to the client', stateLine.slice(0, 60))
  claim(!JSON.parse(flat.replace(/^\{/, '{')).header, 'the card is headerless', 'no title bar')
}
if (answers.length >= 1) {
  const newest = answers[0].text
  claim(/deepseek|[_·]/.test(newest), 'the answer carries the footer line', newest.slice(-90))
}
if (inbound.length >= 1) {
  const reactions = await client.im.v1.messageReaction.list({
    path: { message_id: inbound[0].item.message_id }, params: { page_size: 20 },
  })
  const types = (reactions?.data?.items ?? []).map((r) => r.reaction_type?.emoji_type).filter(Boolean)
  claim(types.length >= 1, 'the bot reacted to your message (accepted → done state machine)',
    types.join(', ') || 'no reactions')
  claim(types.includes('CheckMark') || types.includes('DONE') || types.includes('THUMBSUP'),
    'the turn ended on a tick', types.join(', ') || '—')
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${failed === 0 ? 'ROUND TRIP VERIFIED' : `${failed} CHECK(S) FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
