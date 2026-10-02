/**
 * Surfaces: the headerless one-line process card, the status card, and the
 * answer body. Pure builders — no Feishu calls — so the display can be tested
 * without a network (test/harness.mjs, test/integration.mjs).
 *
 * Design rules (Jeremy, 2026-10-02):
 *   - no header, no colour bar, no button rows;
 *   - the process is ONE line with one icon, detail behind a tap;
 *   - a small ⏹ on the same card while a turn runs;
 *   - the answer is an ordinary chat message, not a card, with a small footer.
 *
 * CARD VERSION — measured, not assumed (2026-10-02, `scripts/probe-cards.mjs`):
 *   schema 2.0 renders as the platform's "please upgrade your client"
 *   placeholder on the target client, and `collapsible_panel` is version-gated
 *   too (it degrades to that same placeholder inside an otherwise fine 1.0
 *   card). So the default build is **v1**, and "click to expand" is implemented
 *   as our own toggle button that patches the card in place — which works on any
 *   client that can draw a button. `cardVersion: 'v2'` keeps the richer build for
 *   clients that support it.
 */
import { detailMarkdown, footerParts, statusLine } from './turn.js'

export const STOP_ACTION = 'feishu-mini/stop'
export const DETAILS_ACTION = 'feishu-mini/details'

function stopButton() {
  return {
    tag: 'button',
    type: 'default',
    text: { tag: 'plain_text', content: '⏹' },
    value: { action: STOP_ACTION, op: 'stop' },
  }
}

function detailsButton(open) {
  return {
    tag: 'button',
    type: 'text',
    text: { tag: 'plain_text', content: open ? 'hide' : 'details' },
    value: { action: DETAILS_ACTION, op: open ? 'close' : 'open' },
  }
}

/** v1: div(lark_md) line, optional detail div, one top-level action row. */
function buildV1(state, config, info, now) {
  const line = statusLine(state, now)
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: line } }]
  const open = info.detailsOpen === true
  if (open && config.processDetail) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: detailMarkdown(state, config.processRows) } })
  }
  const actions = []
  if (state.running && config.stopButton) actions.push(stopButton())
  if (config.processDetail && !justStarted(state)) actions.push(detailsButton(open))
  if (actions.length > 0) elements.push({ tag: 'action', actions })
  const card = { config: { update_multi: true }, elements }
  // A v1 header is a title bar; off by default. `line` opts in for deployments
  // that want the chat list to carry the thinking icon.
  if (config.headerTitle === 'line') {
    card.header = { title: { tag: 'plain_text', content: line }, template: 'grey' }
  }
  return card
}

/** v2: column_set line + tiny button, collapsed panel, custom summary. */
function buildV2(state, config, info, now) {
  const line = statusLine(state, now)
  const elements = []
  const showStop = state.running && config.stopButton
  elements.push({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [{ tag: 'markdown', content: line, text_size: 'notation' }] },
      ...(showStop
        ? [{ tag: 'column', width: 'auto', vertical_align: 'center', elements: [{
            tag: 'button', name: 'fm_stop', size: 'tiny', type: 'text',
            text: { tag: 'plain_text', content: '⏹' },
            behaviors: [{ type: 'callback', value: { action: STOP_ACTION, op: 'stop' } }],
          }] }]
        : []),
    ],
  })
  if (config.processDetail && !justStarted(state)) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: info.detailsOpen === true,
      header: { title: { tag: 'markdown', content: 'details' }, vertical_align: 'center' },
      elements: [{ tag: 'markdown', content: detailMarkdown(state, config.processRows) }],
    })
  }
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: line } },
    body: { elements },
  }
}

/** The live process card. */
export function processCard(state, config, info = {}, now = Date.now()) {
  return config.cardVersion === 'v2' ? buildV2(state, config, info, now) : buildV1(state, config, info, now)
}

/** Before anything has happened a detail view is noise. */
function justStarted(state) {
  return state.tools.length === 0 && state.currentTool === undefined
    && state.reasoning.trim() === '' && state.lastText.trim() === '' && state.liveText.trim() === ''
}

/** The status card: `/status` only. This is where counters live. */
export function statusCard(state, config, info = {}, now = Date.now()) {
  const parts = footerParts(state, info, config.footerFields)
  const lines = [
    `**session** \`${info.sessionId ?? '—'}\``,
    `**workspace** \`${info.cwd ?? '—'}\``,
    `**state** ${statusLine(state, now)}`,
  ]
  if (parts.length > 0) lines.push(`**route** ${parts.join(' · ')}`)
  return { config: { update_multi: true }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }] }
}

/**
 * The answer body: the model's own markdown, then one dim footer line.
 *
 * The footer is PLAIN TEXT on purpose. Feishu's chat-list preview renders the
 * raw message text, not markdown, so an italic `_…_` footer (or any leading
 * decoration) shows up as a literal underscore in the list — Jeremy spotted it
 * on 2026-10-02. A leading em dash reads as a meta line in the rendered message
 * and stays clean in the preview.
 *
 * No separator is emitted when there is no footer, so nothing dangles.
 * (`post`/`md` messages do not support the card-only `<font>` tag either.)
 */
export function answerBody(text, state, config, info = {}) {
  const parts = footerParts(state, info, config.footerFields)
  const body = text.trim()
  if (parts.length === 0) return body
  return `${body}\n\n— ${parts.join(' · ')}`
}

/** A one-line receipt for a turn that produced no text (plain, for the preview). */
export function emptyAnswer(state, now = Date.now()) {
  return `(no output this turn · ${statusLine(state, now)})`
}
