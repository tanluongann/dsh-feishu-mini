# dsh-feishu-mini

A small, opinionated **Feishu / Lark chat surface for [DSH](https://github.com/deepseek-ai/deepseek-harness)** —
built because the existing third-party surfaces are lovely until you want to change how they *look*.

> **Status: pilot.** Phase 1–2 of the design (dispatch, auto-steering, one-line process card, message
> answers, reaction state machine, small footer). Not yet implemented: approval/question cards, the native
> CoT "thinking process" surface, images/files. See *Roadmap*.

## What it looks like

Jeremy's requirements, in his words, are the spec:

* **No large or colourful title bar** — cards are sent **headerless**, and the answer is an ordinary chat
  message, not a card.
* **Thinking is one line**: `🧠 thinking · 12s · 🔧 3`, one icon, and a `details` button that opens the
  detail in place (the native `collapsible_panel` is version-gated on the target client).
* **A small ⏹ while a turn runs** — one button in a top-level action row (v1 cannot put a button in a
  column), never a row of buttons.
* **The icon is visible from the chat list** — the card's `summary` carries the same line, so the list
  shows `🧠 thinking …` and flips to `✅ done` (and `⚠️` / `⏹`) when the turn settles.
* **The answer is rich but button-free**, ending in one dim footer line: model · context · tokens · time
  (each field individually switchable, or off).
* **Sending while it works steers the running turn** instead of queueing a second one.
* **Reactions on your own message**: ⌨️ `Typing` when it picks the message up, `THINKING` when a mid-turn
  message is steered in, a tick `CheckMark` when the turn completes (`CrossMark` on failure, `EYES` when
  stopped).

```
   you  ▸ fix the printer queue
  🤖 ⌨️  (reaction on your message)

  ┌──────────────────────────────────────────────┐
  │ 🧠 thinking · 12s · 🔧 3                   ⏹ │   ← headerless card; the line is the summary
  │ ▸ details                                    │   ← collapsed: tool rows + reasoning tail
  └──────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────┐
  │ Done — the queue had two stuck jobs.         │   ← ordinary post/md message: full GFM
  │                                              │
  │ deepseek-flash · ctx 42% · 21k in / 380 out · 12.4s
  └──────────────────────────────────────────────┘
  🤖 ✅  (reaction on your message)
```

## Install into a profile

```bash
# 1. get the code
git clone https://github.com/tanluongann/dsh-feishu-mini.git ~/.dsh/repos/dsh-feishu-mini
cd ~/.dsh/repos/dsh-feishu-mini && npm install && node scripts/link-closure.mjs

# 2. point the profile at it  (~/.dsh/profiles/<profile>/package.json)
#    "dependencies":  { "dsh-feishu-mini": "link:/home/<you>/.dsh/repos/dsh-feishu-mini" }
#    "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-feishu-mini"] } }

# 3. configure the row  (~/.dsh/profiles/<profile>/cordis.patch.yml)
#    - id: feishu-mini
#      config:
#        domain: feishu              # or lark
#        cwd: /home/<you>/.dsh/<agent>
#        provider: deepseek-official
#        model: deepseek-flash

# 4. install + restart
dsh plugin --profile <profile> install
dsh --profile <profile> --dump-config     # expect the feishu-mini row
systemctl restart dsh-<profile>.service
```

### Credentials

Resolved in this order, and never logged:

1. `appIdEnv` / `appSecretEnv` — the **names** of environment variables to read (preferred: the secret
   stays out of the repo and out of the profile patch);
2. `appId` / `appSecret` — literals, for a quick pilot.

The bundled `cordis.patch.yml` reads `FEISHU_HOUSE_APP_ID` / `FEISHU_HOUSE_APP_SECRET` by default; a
profile patch that targets the row replaces that config wholesale.

## Configuration

| key | default | effect |
|---|---|---|
| `mode` | `on` | `off` keeps the row mounted but inert |
| `domain` | `feishu` | `feishu` (open.feishu.cn) or `lark` (open.larksuite.com) |
| `appId` / `appSecret` | — | literal credentials |
| `appIdEnv` / `appSecretEnv` | — | env var **names** (these win over literals) |
| `operators` | `[]` | open_id allowlist; empty = anyone the app is visible to (warned at boot) |
| `requireMention` | `true` | group chats need an @-mention |
| `cwd` | profile cwd | where new sessions start |
| `provider` / `model` | host default | route for sessions this surface creates |
| `steerMidTurn` | `true` | a message sent mid-turn steers it |
| `beatMs` | `4000` | live-card refresh beat |
| `processLine` | `true` | the one-line card at all |
| `processDetail` | `true` | the collapsed detail panel |
| `processRows` | `4` | tool rows kept in the panel |
| `stopButton` | `true` | the tiny ⏹ on the line |
| `answer` | `message` | `message` \| `card` \| `both` |
| `bodySegmentChars` | `3500` | segment size for long answers |
| `footer` | `model,context,tokens,timings` | comma list, or `off`. Fields: `model provider effort context tokens cache timings tools session` |
| `reactions` | `Typing / THINKING / CheckMark / CrossMark / EYES` | Feishu emoji_type names for accepted / steered / done / failed / stopped |
| `instance` | appId tail | namespace for the state file and derived session ids |

Commands in chat: `/status` (state + route + counters), `/new`, `/stop`, `/display` (the effective flags),
anything else is dispatched to the agent.

## Design notes (the parts that are easy to get wrong)

* **One card per turn, patched in place.** The card is hashed; the beat only patches when the rendered
  content actually changed. A turn therefore leaves *one* card in the chat, not one per model round-trip.
* **The answer never rides the card** (by default). It is a `post` message with the `md` tag, which renders
  full CommonMark + GFM — headings, task lists, and **tables**, which cards only render from client 7.4 up.
* **Cards ship as schema 1.0 by default — measured, not assumed.** On the target client a schema-2.0 card
  renders as the platform's *"please upgrade your client"* placeholder (whole body, title survives), and
  `collapsible_panel` degrades to the same placeholder **inside an otherwise fine 1.0 card**. So: v1 by
  default (`cardVersion: 'v2'` opts back in for clients that support it), and *click to expand* is our own
  `details` button that patches the card in place — no version-gated component involved. Reproduce with
  `node scripts/probe-cards.mjs <chat_id>`, which sends labelled probes and prints what the platform echoes
  back for each.
* **1.0 forbids `action` inside a `column`** (`ErrCode 200410`), so the stop button lives in a top-level
  `action` row rather than beside the text. It is still one small button, not a button row.
* **Reactions are a state machine, not decoration.** Feishu has no "replace": the previous emoji is removed
  before the next is added, and a failed reaction never blocks a turn.
* **State is per instance**, stored in the *profile* directory. Two agents on one host must never share a
  binding slot — the plugin this replaces keeps its state in `$DSH_HOME` and does exactly that.
* **`@deepseek-ai/*` stays undeclared** and is symlinked from the running dsh closure by
  `scripts/link-closure.mjs`; declaring those packages in `package.json` creates a second copy and breaks
  cordis type augmentation.
* **Every outbound operation is chained** (`bot.chain`), so a settle can never interleave with the beat.

## Development

```bash
npm install
node scripts/link-closure.mjs     # point @deepseek-ai at the installed dsh closure
node test/harness.mjs             # 5 groups: config, turn fold, render, state, bot lifecycle
node test/integration.mjs         # 8 groups through the real cordis registry (fiber, effects, dispose)
```

The harness drives the real render/turn/bot code with a fake channel and a fake agent — card geometry,
footer composition, reaction transitions, steering, the stop button, and the "no extra messages per tool
call" rule are all asserted there.

## Roadmap

1. **Approval & question cards** (schema 1.0 — `action` buttons), so a phone can answer what the agent asks.
2. **Native CoT process surface** (`im/v1/message_cot`, opt-in): the platform's own collapsible thinking
   trace. Undocumented and client-gated (PC 7.70 / mobile 7.74), so it stays a side channel with the card
   as the fallback.
3. **Images and files** both ways, with the SDK's upload/download helpers.
4. **`/resume`, model picker, workspace switching** — the old fleet plugin's session surface.

## License

MIT — see [LICENSE](LICENSE).
