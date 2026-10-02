/**
 * Surfaces: the headerless one-line process card, the status card, and the
 * answer body. Nothing here talks to Feishu — these are pure builders, so the
 * display can be tested without a network (see test/harness.mjs).
 *
 * Design rules (Jeremy, 2026-10-02):
 *   - no header, no colour bar, no button rows;
 *   - the process is ONE line with one icon, details behind a collapsed panel;
 *   - a tiny ⏹ sits at the right of that same line while a turn runs;
 *   - the answer is an ordinary chat message, not a card, with a small footer.
 */
import { detailMarkdown, footerParts, statusLine } from './turn.js'

export const STOP_ACTION = 'feishu-mini/stop'

/** Card-level `summary` = the line Feishu shows in the chat list. */
function cardShell(line, elements) {
  return {
    schema: '2.0',
    config: {
      // 2.0 only accepts `true`; a shared card is what lets every reader see updates.
      update_multi: true,
      summary: { content: line },
    },
    body: { elements },
  }
}

function tinyStopButton() {
  return {
    tag: 'button',
    name: 'fm_stop',
    size: 'tiny',
    type: 'text',
    width: 'default',
    text: { tag: 'plain_text', content: '⏹' },
    behaviors: [{ type: 'callback', value: { action: STOP_ACTION, op: 'stop' } }],
  }
}

/** Left = the line, right = the tiny stop — one row, nothing else. */
function lineRow(line, showStop) {
  const left = { tag: 'markdown', content: line, text_size: 'notation' }
  if (!showStop) {
    return { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
    ] }
  }
  return { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: [
    { tag: 'column', width: 'weighted', weight: 1, elements: [left], vertical_align: 'center' },
    { tag: 'column', width: 'auto', elements: [tinyStopButton()], vertical_align: 'center' },
  ] }
}

function detailPanel(state, rows) {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: 'details' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    elements: [{ tag: 'markdown', content: detailMarkdown(state, rows) }],
  }
}

/** The live process card — one line, optional tiny stop, collapsed details. */
export function processCard(state, config, info = {}, now = Date.now()) {
  const line = statusLine(state, now)
  const elements = [lineRow(line, state.running && config.stopButton)]
  if (config.processDetail && !justStarted(state)) elements.push(detailPanel(state, config.processRows))
  return cardShell(line, elements)
}

/** Before anything has happened a details panel is noise. */
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
  return cardShell('status', [{ tag: 'markdown', content: lines.join('\n') }])
}

/**
 * The answer body: the model's own markdown, then one dim footer line.
 * No `---` is emitted when there is no footer, so nothing dangles.
 */
export function answerBody(text, state, config, info = {}) {
  const parts = footerParts(state, info, config.footerFields)
  const body = text.trim()
  if (parts.length === 0) return body
  return `${body}\n\n<font color='grey'>${parts.join(' · ')}</font>`
}

/** A one-line receipt for a turn that produced no text. */
export function emptyAnswer(state, now = Date.now()) {
  return `_(no output this turn · ${statusLine(state, now)})_`
}
