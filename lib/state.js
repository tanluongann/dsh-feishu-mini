/**
 * Per-instance state, stored inside the *profile* directory.
 *
 * This is the deliberate opposite of the plugin we are replacing: its state
 * file lives in `$DSH_HOME` and is therefore shared by every agent on the host
 * (one binding slot, one last-chat, one display toggle for all of them). Here
 * the file name carries the instance namespace, so two profiles — or two rows
 * in one profile — can never overwrite each other's binding.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const EMPTY = { version: 1, chats: {}, display: {} }

export class StateStore {
  constructor(directory, instance) {
    this.path = join(directory, `feishu-mini-${instance}.json`)
    this.data = { ...EMPTY }
  }

  load() {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        this.data = { ...EMPTY, ...parsed, chats: parsed.chats ?? {}, display: parsed.display ?? {} }
        return this.data
      }
    } catch {
      // missing or malformed: start clean rather than refusing to arm
    }
    this.data = { ...EMPTY }
    return this.data
  }

  get() {
    return this.data
  }

  update(patch) {
    this.data = { ...this.data, ...patch }
    this.save()
    return this.data
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // persistence is best-effort: a read-only profile dir must not kill the bot
    }
  }
}
