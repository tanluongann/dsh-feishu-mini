/**
 * Live probe: run the surface against a REAL DSH agent.
 *
 * Everything the unit and integration suites fake, this one does for real —
 * a real session is created through `ctx.agents.create`, a real model turn
 * runs, and real `session/event` / `agent/assistant-stream` payloads are folded
 * into the card and the answer. Only Feishu itself is faked (an outbound
 * channel object), because no bot can DM itself.
 *
 * Mount it in a throwaway profile and run that profile; the probe prints a JSON
 * summary and exits the process (0 = every claim held).
 */
export const name = 'fm-live-probe'
export const inject = ['agents']

const results = []
const record = (claim, ok, detail) => {
  results.push({ claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function run(ctx, config) {
  const dir = config.pluginDir
  const { HouseBot } = await import(`${dir}/lib/bot.js`)
  const { Config } = await import(`${dir}/lib/config.js`)
  const { StateStore } = await import(`${dir}/lib/state.js`)
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const sent = []
  const updated = []
  const reactions = []
  const removed = []
  const handlers = {}
  const channel = {
    on: (name, handler) => { handlers[name] = handler },
    connect: async () => {},
    disconnect: async () => {},
    send: async (chatId, input) => { sent.push({ chatId, input }); return { messageId: `om_${sent.length}` } },
    updateCard: async (messageId, card) => { updated.push({ messageId, card }) },
    addReaction: async (messageId, emoji) => { reactions.push(emoji); return 'rx' },
    removeReactionByEmoji: async (messageId, emoji) => { removed.push(emoji); return true },
  }

  const cwd = mkdtempSync(join(tmpdir(), 'fm-live-'))
  const workspace = new StateStore(cwd, 'liveprobe')
  workspace.load()
  const botConfig = Config({
    appId: 'cli_probe', appSecret: 'probe', cwd,
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    footer: 'model,context,tokens,timings', beatMs: 2000,
  })
  botConfig.footerFields = botConfig.footer.split(',').map((s) => s.trim())

  const bot = new HouseBot({
    ctx, config: botConfig, channel, store: workspace, logger: ctx.logger,
    info: { instance: 'liveprobe', cwd },
  })
  // the same wiring lib/index.js does
  ctx.on('session/event', (session, event) => bot.onSessionEvent(session, event))
  ctx.on('agent/assistant-stream', (payload) => bot.onStreamFrame(payload))

  await bot.start()
  record('surface started against the real host', true)

  handlers.message({ messageId: 'om_probe_in', chatId: 'oc_probe', content: config.prompt, senderIsBot: false })
  await bot.chain(() => Promise.resolve()) // inbound work rides the card chain
  const entry = [...bot.chats.values()][0]
  if (entry === undefined) throw new Error('no chat entry was created for the inbound message')
  // the scratch session can be reused across runs, so compare turn COUNTERS
  const turnBeforeRun = entry.turn.turn ?? 0
  const sessionId = entry.sessionId

  // -------- auto-steering against a REAL agent -------------------------------
  // Wait for the turn to actually be live (its card is opened on turn/start),
  // then send a second message: it must be STEERED into the running turn, not
  // queued as a new one — one card, one answer, one turn number.
  if (config.steerPrompt !== undefined) {
    const cardDeadline = Date.now() + 15000
    while (Date.now() < cardDeadline && !sent.some((s) => s.input.card !== undefined)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const wasRunning = entry.turn.running === true
    handlers.message({ messageId: 'om_probe_steer', chatId: 'oc_probe', content: config.steerPrompt, senderIsBot: false })
    await bot.chain(() => Promise.resolve())
    record('a message sent mid-turn is steered into the running turn', wasRunning, wasRunning ? 'turn was running' : 'turn had already ended — inconclusive')
    record('steering shows the THINKING reaction', reactions.includes('THINKING'), reactions.join(' → '))
  }

  const deadline = Date.now() + (config.timeoutMs ?? 120000)
  let answer
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (!entry.turn.running && entry.turn.endReason !== undefined && sent.some((s) => s.input.markdown !== undefined)) {
      answer = sent.filter((s) => s.input.markdown !== undefined).at(-1)
      break
    }
  }

  const live = ctx.get('agents')?.get?.(sessionId)
  const liveAgent = live?.agent ?? live
  record('the host created a session under OUR id', String(liveAgent?.id ?? '') === sessionId, `${sessionId} → ${liveAgent?.id ?? 'none'}`)
  record('a real turn ran and settled', entry.turn.endReason !== undefined, `reason=${JSON.stringify(entry.turn.endReason)}`)
  record('the process card was opened exactly once', sent.filter((s) => s.input.card !== undefined).length === 1,
    `${sent.filter((s) => s.input.card !== undefined).length} card message(s)`)
  record('the card was patched in place, never re-sent', updated.length >= 1 && sent.filter((s) => s.input.card !== undefined).length === 1,
    `${updated.length} patch(es)`)
  record('the answer is a plain markdown message', answer !== undefined, answer === undefined ? 'no answer' : `${answer.input.markdown.length} chars`)
  const body = answer?.input.markdown ?? ''
  record('the answer carries the model footer', /deepseek|_/.test(body), body.split('\n').at(-1)?.slice(0, 80) ?? '')
  record('reactions ran accepted → done', reactions.includes('Typing') && reactions.includes('CheckMark'), reactions.join(' → '))
  record('the settled card shows a tick', JSON.stringify(updated.at(-1)?.card ?? {}).includes('✅'),
    JSON.stringify(updated.at(-1)?.card?.elements?.[0]?.text?.content ?? ''))
  record('the answer echoes the model output', body.includes('PROBE OK'), body.split('\n')[0].slice(0, 60))
  if (config.steerPrompt !== undefined) {
    // The proof that the steer stayed inside the turn: ONE card (a new turn
    // would open another on turn/start), ONE answer, and an extra model round.
    record('a steer stayed inside the same turn', sent.filter((s) => s.input.card !== undefined).length === 1
      && sent.filter((s) => s.input.markdown !== undefined).length === 1
      && entry.turn.rounds >= 2,
      `cards=${sent.filter((s) => s.input.card !== undefined).length} answers=${sent.filter((s) => s.input.markdown !== undefined).length} rounds=${entry.turn.rounds} (previous turn counter ${turnBeforeRun})`)
    record('a steer did not produce a second answer message', sent.filter((s) => s.input.markdown !== undefined).length === 1,
      `${sent.filter((s) => s.input.markdown !== undefined).length} answer message(s)`)
  }

  console.log('\nSUMMARY', JSON.stringify({
    sessionId,
    endReason: entry.turn.endReason,
    rounds: entry.turn.rounds,
    tools: entry.turn.tools.map((t) => `${t.name}:${t.ok ? 'ok' : 'fail'}`),
    usage: entry.turn.usage,
    model: entry.turn.model,
    cardsSent: sent.filter((s) => s.input.card !== undefined).length,
    patches: updated.length,
    messages: sent.filter((s) => s.input.markdown !== undefined).length,
    turnNumber: entry.turn.turn,
    reactions,
    removed,
    answerFirstLine: body.split('\n')[0]?.slice(0, 80),
    answerFooter: body.split('\n').at(-1)?.slice(0, 80),
  }, null, 2))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? 'ALL LIVE CLAIMS HELD' : `${failed.length} CLAIM(S) FAILED`}`)
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 300)
}

export function apply(ctx, config) {
  ctx.effect(() => {
    void run(ctx, config).catch((error) => {
      console.error('PROBE ERROR', error)
      setTimeout(() => process.exit(1), 200)
    })
    return () => {}
  })
}
