#!/usr/bin/env node
/**
 * Card-rendering probe: send three labelled cards and print what the platform
 * reports back for each, so we can tell a *client/version* fallback from a bad
 * card. Outbound only — no WebSocket is opened.
 *
 *   node scripts/probe-cards.mjs <chat_id>
 */
import { createLarkChannel } from '@larksuite/channel'

const chatId = process.argv[2]
if (chatId === undefined) {
  console.error('usage: node scripts/probe-cards.mjs <chat_id>')
  process.exit(2)
}
const appId = process.env.FEISHU_MINI_APP_ID
const appSecret = process.env.FEISHU_MINI_APP_SECRET
if (appId === undefined || appSecret === undefined) {
  console.error('set FEISHU_MINI_APP_ID / FEISHU_MINI_APP_SECRET')
  process.exit(2)
}

const channel = createLarkChannel({ appId, appSecret, domain: 0, transport: 'websocket' })
const client = channel.rawClient

const line = '🧠 probe · thinking · 12s · 🔧 3'

/** A — our own card shape: headerless, schema 2.0, column_set + tiny button. */
const probeA = {
  schema: '2.0',
  config: { update_multi: true, summary: { content: line } },
  body: { elements: [
    { tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: line }] },
      { tag: 'column', width: 'auto', elements: [
        { tag: 'button', name: 'fh_stop', size: 'tiny', type: 'text', text: { tag: 'plain_text', content: '⏹' }, behaviors: [{ type: 'callback', value: { action: 'feishu-mini/stop' } }] },
      ] },
    ] },
  ] },
}

/** B — schema 1.0: headerless body, div + lark_md, action container + button. */
const probeB = {
  config: { update_multi: true },
  elements: [
    { tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'div', text: { tag: 'lark_md', content: line } }] },
      { tag: 'column', width: 'auto', elements: [
        { tag: 'action', actions: [{ tag: 'button', size: 'tiny', type: 'text', text: { tag: 'plain_text', content: '⏹' }, value: { action: 'feishu-mini/stop' } }] },
      ] },
    ] },
  ],
}

/** C — the shape our sister plugin sends (schema 2.0 + titled header). */
const probeC = {
  schema: '2.0',
  config: { update_multi: true, summary: { content: 'probe C' } },
  header: { title: { tag: 'plain_text', content: 'Round 1 · probe C' }, template: 'blue' },
  body: { elements: [{ tag: 'markdown', content: '##### probe C\nschema 2.0 with a header' }] },
}

/** B2 — 1.0 with the action row at the TOP level (1.0 forbids action inside a column). */
const probeB2 = {
  config: { update_multi: true },
  elements: [
    { tag: 'div', text: { tag: 'lark_md', content: line } },
    { tag: 'collapsible_panel', expanded: false,
      header: { title: { tag: 'plain_text', content: 'details' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '- 🔧 bash · ✔ 3.2s' } }] },
    { tag: 'action', actions: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: '⏹ stop' }, value: { action: 'feishu-mini/stop' } }] },
  ],
}

/** B3 — B2 plus a grey header carrying the same line (the 1.0 chat-list candidate). */
const probeB3 = {
  config: { update_multi: true },
  header: { title: { tag: 'plain_text', content: line }, template: 'grey' },
  elements: probeB2.elements,
}

const mode = process.argv[3] ?? 'all'
const probes = mode === 'v1'
  ? [['B2: 1.0 + action row', probeB2], ['B3: 1.0 + grey header', probeB3]]
  : [['A: 2.0 headerless (ours)', probeA], ['B: 1.0 action in column (invalid)', probeB], ['C: 2.0 + header', probeC], ['B2: 1.0 + action row', probeB2], ['B3: 1.0 + grey header', probeB3]]

const sent = []
for (const [label, card] of probes) {
  try {
    const result = await channel.send(chatId, { card })
    sent.push({ label, messageId: result.messageId })
    console.log(`sent ${label} → ${result.messageId}`)
  } catch (error) {
    console.log(`FAILED to send ${label}: ${error?.code ?? ''} ${error?.message ?? error}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 800))
}

// read each back: a real card comes back as the card JSON, an unsupported one
// comes back as the platform's "please upgrade your client" fallback.
await new Promise((resolve) => setTimeout(resolve, 2500))
for (const { label, messageId } of sent) {
  const response = await client.im.v1.message.get({ path: { message_id: messageId } })
  const item = response?.data?.items?.[0]
  const raw = item?.body?.content ?? ''
  const upgrade = raw.includes('请升级') || raw.includes('upgrade')
  const echo = raw.includes('probe') || raw.includes('feishu-mini/stop')
  console.log(`\n${label}\n  upgrade-placeholder: ${upgrade}\n  card echoed back:    ${echo}\n  content: ${raw.slice(0, 200)}`)
}
process.exit(0)
