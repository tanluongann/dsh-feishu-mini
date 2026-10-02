/**
 * Turn state: the pure event→state fold behind the process line.
 *
 * Everything here is defensive on purpose — a surface must never crash (or
 * "eat" a turn) because a host payload grew a field. Unknown event types are
 * ignored, unknown content shapes degrade to empty text.
 */

const REASONING_CAP = 4000
const TEXT_CAP = 4000

export function initialTurn() {
  return {
    running: false,
    phase: 'idle', // idle | thinking | tool | writing | stopping | done | failed | stopped
    turn: 0,
    step: 0,
    startedAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    tools: [],
    currentTool: undefined,
    rounds: 0,
    lastText: '',
    liveText: '',
    reasoning: '',
    sawReasoning: false,
    usage: undefined,
    model: undefined,
    provider: undefined,
    effort: undefined,
    contextWindow: undefined,
    firstTokenAt: undefined,
    errorLine: undefined,
  }
}

/** Text blocks of a message content payload, joined. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) parts.push(block.text)
  }
  return parts.join('')
}

const clip = (value, cap) => (value.length <= cap ? value : value.slice(value.length - cap))

function beginTurn(state, time) {
  state.running = true
  state.phase = 'thinking'
  state.startedAt = time
  state.endedAt = undefined
  state.endReason = undefined
  state.tools = []
  state.currentTool = undefined
  state.rounds = 0
  state.lastText = ''
  state.liveText = ''
  state.reasoning = ''
  state.sawReasoning = false
  state.firstTokenAt = undefined
  state.errorLine = undefined
}

function endTurn(state, time, reason) {
  state.running = false
  state.endedAt = time
  state.endReason = reason
  state.currentTool = undefined
  const kind = reason?.kind ?? reason
  state.phase = kind === 'completed' ? 'done'
    : kind === 'error' ? 'failed'
      : kind === 'aborted' ? 'stopped'
        : kind === 'max-tokens' ? 'done'
          : 'done'
}

/** Fold one durable `session/event` of the bound session. */
export function foldEvent(state, event, time = Date.now()) {
  if (event === null || typeof event !== 'object') return state
  const data = event.data ?? event // payloads ride `.data` on the firehose
  const type = event.type
  switch (type) {
    case 'turn/start':
      beginTurn(state, time)
      if (typeof data.turn === 'number') state.turn = data.turn
      break
    case 'turn/end':
      if (typeof data.turn === 'number') state.turn = data.turn
      endTurn(state, time, data.reason)
      break
    case 'step/start':
      if (typeof data.step === 'number') state.step = data.step
      break
    case 'tool/call':
      state.currentTool = { name: String(data.name ?? 'tool'), startedAt: time }
      state.phase = 'tool'
      break
    case 'tool/result': {
      const name = state.currentTool?.name ?? String(data.name ?? 'tool')
      const startedAt = state.currentTool?.startedAt ?? time
      state.tools.push({ name, ms: Math.max(0, time - startedAt), ok: data.error === undefined })
      if (state.tools.length > 50) state.tools.shift()
      state.currentTool = undefined
      state.phase = 'thinking'
      break
    }
    case 'assistant/message': {
      state.rounds += 1
      const text = textOf(data.message?.content)
      if (text !== '') state.lastText = text
      state.liveText = ''
      if (data.usage !== undefined && typeof data.usage === 'object') state.usage = mergeUsage(state.usage, data.usage)
      state.phase = state.running ? 'thinking' : state.phase
      break
    }
    case 'request/context':
      if (typeof data.provider === 'string') state.provider = data.provider
      if (typeof data.model === 'string') state.model = data.model
      if (typeof data.contextWindow === 'number') state.contextWindow = data.contextWindow
      break
    case 'request/header': {
      const cfg = data.header?.config
      if (cfg !== null && typeof cfg === 'object') {
        if (typeof cfg.model === 'string') state.model = cfg.model
        if (typeof cfg.provider === 'string') state.provider = cfg.provider
        if (typeof cfg.reasoningEffort === 'string') state.effort = cfg.reasoningEffort
      }
      break
    }
    case 'llm/retry':
      state.errorLine = 'retrying'
      break
    default:
      break
  }
  return state
}

function mergeUsage(previous, next) {
  const sum = (a, b) => (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0)
  return {
    inputTokens: sum(previous?.inputTokens, next.inputTokens),
    outputTokens: sum(previous?.outputTokens, next.outputTokens),
    cacheReadTokens: sum(previous?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(previous?.cacheWriteTokens, next.cacheWriteTokens),
    totalTokens: sum(previous?.totalTokens, next.totalTokens),
  }
}

/** Fold one `agent/assistant-stream` frame (live reasoning/text deltas). */
export function foldStream(state, frame, time = Date.now()) {
  if (frame === null || typeof frame !== 'object') return state
  if (frame.type === 'start') {
    // `revision` restarts at 1 on replacement: a start frame is a baseline reset.
    state.liveText = ''
    state.reasoning = ''
    return state
  }
  if (frame.type !== 'chunk') return state
  const chunk = frame.chunk
  if (chunk === null || typeof chunk !== 'object') return state
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    state.reasoning = clip(state.reasoning + chunk.text, REASONING_CAP)
    state.sawReasoning = true
    if (state.phase !== 'tool') state.phase = 'thinking'
  } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    if (state.firstTokenAt === undefined) state.firstTokenAt = time
    state.liveText = clip(state.liveText + chunk.text, TEXT_CAP)
    state.phase = 'writing'
  } else if (chunk.type === 'usage' && chunk.usage !== undefined) {
    state.usage = mergeUsage(state.usage, chunk.usage)
  }
  return state
}

// --------------------------------------------------------------- formatting --

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}

export function formatCount(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The one-line status: icon, phase word, and only the numbers that matter. */
export function statusLine(state, now = Date.now()) {
  const elapsed = formatDuration((state.endedAt ?? now) - (state.startedAt ?? now))
  const tools = state.tools.length
  if (!state.running && state.phase === 'idle') return '💤 idle'
  switch (state.phase) {
    case 'thinking':
      return `🧠 thinking · ${elapsed}${tools > 0 ? ` · 🔧 ${tools}` : ''}`
    case 'tool':
      return `🔧 ${state.currentTool?.name ?? 'tool'} · ${formatDuration(now - (state.currentTool?.startedAt ?? now))}`
    case 'writing':
      return `✍️ writing · ${elapsed}`
    case 'stopping':
      return `⏸️ stopping · ${elapsed}`
    case 'done':
      return `✅ done · ${elapsed}${tools > 0 ? ` · 🔧 ${tools}` : ''}`
    case 'failed':
      return `⚠️ failed · ${elapsed}`
    case 'stopped':
      return `⏹ stopped · ${elapsed}`
    default:
      return `🧠 working · ${elapsed}`
  }
}

/** The collapsible detail body: what it did, what it is doing, what it thought. */
export function detailMarkdown(state, rows = 4) {
  const lines = []
  const recent = state.tools.slice(-rows)
  for (const tool of recent) {
    lines.push(`- 🔧 ${tool.name} · ${tool.ok ? '✔' : '✘'} ${formatDuration(tool.ms)}`)
  }
  if (state.currentTool !== undefined) {
    lines.push(`- 🔧 ${state.currentTool.name} · ⏳`)
  }
  if (state.tools.length > recent.length) lines.push(`- … ${state.tools.length - recent.length} more`)
  const live = state.liveText.trim() === '' ? state.lastText : state.liveText
  if (live.trim() !== '') {
    const first = live.trim().split('\n')[0]
    lines.push(`- 💬 _${first.length > 160 ? `${first.slice(0, 160)}…` : first}_`)
  }
  if (state.reasoning.trim() !== '') {
    const tail = state.reasoning.trim().split('\n').slice(-3).join('\n')
    lines.push('', '```', tail.length > 400 ? tail.slice(-400) : tail, '```')
  }
  if (state.errorLine !== undefined) lines.push(`- ⚠️ ${state.errorLine}`)
  return lines.length === 0 ? '_no activity yet_' : lines.join('\n')
}

/** Footer facts, each gated by the configured field list. */
export function footerParts(state, info, fields) {
  const out = []
  for (const field of fields) {
    switch (field) {
      case 'model': {
        const model = info.model ?? state.model
        if (typeof model === 'string' && model !== '') out.push(model)
        break
      }
      case 'provider':
        if (typeof state.provider === 'string' && state.provider !== '') out.push(state.provider)
        break
      case 'effort':
        if (typeof state.effort === 'string' && state.effort !== '' && state.effort !== 'off') out.push(`effort ${state.effort}`)
        break
      case 'context': {
        const used = state.usage?.inputTokens
        const window = state.contextWindow
        if (typeof used === 'number' && typeof window === 'number' && window > 0) {
          out.push(`ctx ${Math.round((used / window) * 100)}%`)
        }
        break
      }
      case 'tokens': {
        const usage = state.usage
        if (usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
          out.push(`${formatCount(usage.inputTokens)} in / ${formatCount(usage.outputTokens)} out`)
        }
        break
      }
      case 'cache': {
        const read = state.usage?.cacheReadTokens
        const input = state.usage?.inputTokens
        if (typeof read === 'number' && typeof input === 'number' && input + read > 0) {
          out.push(`cache ${Math.round((read / (input + read)) * 100)}%`)
        }
        break
      }
      case 'timings': {
        if (state.startedAt !== undefined && state.endedAt !== undefined) {
          out.push(formatDuration(state.endedAt - state.startedAt))
        }
        break
      }
      case 'tools':
        if (state.tools.length > 0) out.push(`${state.tools.length} tools`)
        break
      case 'session':
        if (typeof info.sessionId === 'string' && info.sessionId !== '') out.push(info.sessionId)
        break
      default:
        break
    }
  }
  return out
}
