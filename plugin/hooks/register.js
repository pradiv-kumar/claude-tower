// Claude Tower: every Claude session on this machine publishes what it's doing to
// the shared $.store and mirrors all of them to a status file the menu bar app
// reads. With the `deck` option on, every session's band also draws them as a
// grid of cards, so a tab that needs you is visible from whichever tab you're in.

const KEY = 'session:'
const OWNER = 'owner:'
const INSTANCE = Math.random().toString(36).slice(2)
const TICK_MS = 1000
const BEAT_MS = 3000
const PLACE_MS = 10000
// A session killed without session.end (crash, kill -9, closed tab) stops
// heartbeating; past this it's dropped from every deck.
const STALE_MS = 15000
const ASK_GRACE_MS = 2000

const MIN_CARD = 40
const GAP = 1
const AGENT_ROWS = 3

const SPIN = ['◐', '◓', '◑', '◒']

const STATES = {
  working: { glyph: null, color: 'cyan', word: 'Working' },
  waiting: { glyph: '✻', color: 'yellow', word: 'Needs approval', loud: true },
  asking: { glyph: '?', color: 'yellow', word: 'Has a question', loud: true },
  done: { glyph: '✓', color: 'green', word: 'Done' },
  shells: { glyph: '◌', color: 'blue', word: 'Done · shells running' },
  stopped: { glyph: '■', color: 'gray', word: 'Stopped' },
  error: { glyph: '✗', color: 'red', word: 'Error', loud: true },
  idle: { glyph: '∙', color: 'gray', word: 'Idle' },
}

const AGENT_LIVE = new Set(['pending', 'running', 'waiting'])
const AGENT_GLYPH = { completed: ['✓', 'green'], failed: ['✗', 'red'], killed: ['■', 'gray'], idle: ['∙', 'gray'] }

let me = null
let peers = []
let seen = new Map()
let frame = 0
// tool_use_id → { tool, agentId, rule, shown, promoted }: 'ask' verdicts. Only
// one the engine actually puts in front of you (classic.PermissionRequest) is
// shown, and promoted once it outlasts the grace period.
const asks = new Map()
// tool_use_id → { agentId, what }: in-flight calls, so a prompt can say who asks.
const calls = new Map()
let mainActive = false
let endState = 'idle'
// Agents already finished when the current task began belong to an earlier
// task; hiding them keeps the progress bar about what you just asked for.
let settledBefore = new Set()

const basename = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p
const now = () => Date.now()
const oneLine = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function fmtAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h' + String(m % 60).padStart(2, '0')
}

// Branch names run long (feature_checkout_redesign_PROJ-1234); the ticket id is
// what tells two tabs apart.
function shortBranch(branch) {
  if (!branch) return ''
  const ticket = branch.match(/[A-Z][A-Za-z]*[-_]\d+/)
  if (ticket) return ticket[0].replace('_', '-')
  return branch.length > 24 ? branch.slice(0, 23) + '…' : branch
}

function describeTool(e) {
  const file = basename(e.file_path || e.notebook_path || e.path || '')
  switch (e.tool) {
    case 'Read':
      return 'Reading ' + file
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'Editing ' + file
    case 'Bash':
      return 'Running ' + (e.description || e.command || 'a command')
    case 'Grep':
    case 'Glob':
      return 'Searching ' + (e.pattern || '')
    case 'Agent':
      return 'Delegating ' + (e.description || 'to a subagent')
    case 'Skill':
      return 'Running /' + (e.skill || 'skill')
    case 'WebFetch':
    case 'WebSearch':
      return 'Browsing the web'
    case 'AskUserQuestion':
      return 'Asking you a question'
    case 'TodoWrite':
      return 'Updating the plan'
    default:
      return e.tool && e.tool.startsWith('mcp__') ? 'Calling ' + e.tool.split('__').slice(1).join(' ') : 'Using ' + e.tool
  }
}

const blocked = () => [...asks.values()].some((a) => a.promoted)

const liveAgents = () => (me?.agents || []).filter((a) => AGENT_LIVE.has(a.status))

// The turn answered but work it started goes on. Subagents will hand results
// back and the session carries on with them, so it's still working; background
// shells only wake it to report, so it reads as done with shells running.
function settledState() {
  if (endState !== 'done') return endState
  if (liveAgents().length) return 'working'
  return me?.shells?.length ? 'shells' : 'done'
}

// Re-reads the settled state once the main loop is idle: subagents finish on
// their own clock, long after the turn that started them.
function settle($) {
  if (!me || mainActive || blocked() || me.state === 'waiting' || me.state === 'asking') return
  const state = settledState()
  const n = liveAgents().length
  setActivity($, state === 'working' ? `Waiting on ${n} subagent${n === 1 ? '' : 's'}` : '')
  setState($, state)
}

function shellText(sh) {
  return sh.description || sh.command || 'a shell'
}

function waitingText(call, tool) {
  const what = call?.what || 'Using ' + tool
  const verb = 'Approve: ' + what.charAt(0).toLowerCase() + what.slice(1)
  if (!call?.agentId) return oneLine(verb, 120)
  const agent = (me?.agents || []).find((a) => a.id === call.agentId)
  return oneLine(`${verb} · from ${agent?.description || 'a subagent'}`, 120)
}

async function git($, args) {
  try {
    const r = await $.process.run(['git', ...args], { cwd: me.cwd, env: { GIT_OPTIONAL_LOCKS: '0' } })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// The menu bar app selects this session's terminal tab by its tty. A spawned
// process may be detached from the terminal (tty "??"), so this walks up the
// parents until one still holds it.
const TTY_SCRIPT =
  'p=$$; while [ "${p:-0}" -gt 1 ]; do t=$(ps -o tty= -p "$p" | tr -d " "); ' +
  'case "$t" in ""|"??") p=$(ps -o ppid= -p "$p" | tr -d " ");; *) echo "/dev/$t"; exit 0;; esac; done; exit 1'

async function findTty($) {
  try {
    const r = await $.process.run(['sh', '-c', TTY_SCRIPT])
    const tty = r.exitCode === 0 ? r.stdout.trim() : ''
    return /^\/dev\/ttys\d+$/.test(tty) ? tty : undefined
  } catch {
    return undefined
  }
}

// A few words on what the session is doing, for the menu bar app, where every
// card would otherwise read "myapp · PROJ-…". Your recent requests go in rather
// than just the last, since "done" or "yes" says nothing about the topic.
const recentAsks = []
let titleSeq = 0

async function retitle($, text) {
  recentAsks.push(oneLine(text, 300))
  if (recentAsks.length > 4) recentAsks.shift()
  if (me?.title && text.length < 12) return
  const seq = ++titleSeq
  const prompt =
    `Recent requests a developer gave a coding assistant, oldest first:\n` +
    recentAsks.map((a, i) => `${i + 1}. ${a}`).join('\n') +
    `\n\nCurrent title: ${me?.title || '(none)'}\n\n` +
    `Reply with a 2-5 word title for what the assistant is working on now, in Title Case, no quotes or ` +
    `punctuation at the end. Keep the current title unless the latest request moves to a different topic.`
  try {
    const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 20, timeoutMs: 15000 })
    const title = r.isAnswered ? oneLine(r.text.replace(/^["'\s]+|["'.\s]+$/g, ''), 40) : ''
    if (!title || seq !== titleSeq || !me) return
    me.title = title
    publish($).catch(() => {})
  } catch {}
}

async function refreshPlace($) {
  if (!me) return
  const top = await git($, ['rev-parse', '--show-toplevel'])
  me.project = basename(top || me.cwd)
  const branch = await git($, ['branch', '--show-current'])
  me.branch = branch || 'detached'
}

async function publish($) {
  if (!me) return
  // A module instance a reload replaced can keep heartbeating its stale state
  // into the same key; only the newest instance of this session writes.
  const owner = await $.store.get(OWNER + me.id)
  if (owner && owner !== INSTANCE) return
  await $.store.set(KEY + me.id, { ...me, beat: now() })
}

function setState($, state) {
  if (!me || me.state === state) return
  me.state = state
  me.since = now()
  publish($).catch(() => {})
  $.ui.invalidate('ui.render')
}

function setActivity($, text) {
  if (!me || me.activity === text) return
  me.activity = text
  $.ui.invalidate('ui.render')
}

async function refreshAgents($) {
  if (!me) return
  let list = []
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  me.agents = list
    .filter((a) => !settledBefore.has(a.id))
    .map((a) => ({ id: a.id, status: a.status, type: a.type, description: oneLine(a.description, 60) }))
}

function label(s) {
  return s.project + (s.branch ? ' · ' + shortBranch(s.branch) : '')
}

// The menu bar app (menubar/) reads this file, so a status is visible outside
// the terminal. The engine's own store file is an internal format; this one is
// the contract. Every session writes the same snapshot, so whichever wrote last
// is correct; the app drops sessions by their `beat`.
let statusPath = ''

async function resolveStatusPath($) {
  const home = await $.env.get('HOME').catch(() => undefined)
  statusPath = home ? `${home}/.claude/claude-tower-status.json` : ''
}

let lastStatus = ''
let lastStatusAt = 0

function writeStatusFile($, list) {
  const path = statusPath
  if (!path) return
  const sessions = list.map((s) => ({
    id: s.id,
    project: s.project,
    branch: s.branch,
    tty: s.tty,
    state: s.state,
    since: s.since,
    task: s.task,
    title: s.title,
    activity: s.activity,
    waitingFor: s.waitingFor,
    agents: (s.agents || []).map((a) => ({ status: a.status, description: a.description })),
    shells: (s.shells || []).map((sh) => ({ description: sh.description, command: sh.command })),
    beat: s.id === me?.id ? now() : s.beat,
  }))
  const body = JSON.stringify(sessions.map(({ beat, ...rest }) => rest))
  // Unchanged content still gets rewritten now and then so the app's staleness
  // check sees live heartbeats.
  if (body === lastStatus && now() - lastStatusAt < BEAT_MS) return
  lastStatus = body
  lastStatusAt = now()
  $.fs.write(path, JSON.stringify({ version: 1, updatedAt: now(), sessions }, null, 2)).catch(() => {})
}

async function refreshPeers($) {
  if (!me) return
  const list = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY)) continue
    const s = await $.store.get(key)
    if (!s || typeof s !== 'object') continue
    if (s.id !== me.id && now() - (s.beat || 0) > STALE_MS) {
      $.store.delete(key).catch(() => {})
      $.store.delete(OWNER + s.id).catch(() => {})
      continue
    }
    list.push(s.id === me.id ? { ...me } : s)
  }
  list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  writeStatusFile($, list)

  // Only announce changes in other tabs; this tab already shows its own. With
  // the deck off the menu bar app is the one place that announces anything.
  for (const s of list) {
    const prev = seen.get(s.id)
    if (deck && prev !== undefined && prev !== s.state && s.id !== me.id) {
      if (STATES[s.state]?.loud) $.ui.toast(`✻ ${label(s)}: ${STATES[s.state].word.toLowerCase()}`, { timeoutMs: 6000 })
      else if (s.state === 'done') $.ui.toast(`✓ ${label(s)} finished`)
      else if (s.state === 'shells') {
        const n = (s.shells || []).length
        $.ui.toast(`◌ ${label(s)} finished · ${n} shell${n === 1 ? '' : 's'} still running`)
      }
    }
    seen.set(s.id, s.state)
  }
  peers = list
}

async function tick($) {
  frame += 1
  try {
    await refreshAgents($)
    settle($)
    await refreshPeers($)
  } catch {}
  $.ui.invalidate('ui.render')
}

async function start($) {
  if (me) return
  const id = await $.session.id()
  const prev = await $.store.get(KEY + id)
  // A reload of this module mid-session keeps the state it had published.
  me =
    prev && typeof prev === 'object'
      ? { ...prev }
      : { id, cwd: await $.session.cwd(), state: 'idle', since: now(), startedAt: now() }
  me.cwd = me.cwd || (await $.session.cwd())
  delete me.dirty
  delete me.ahead
  // A prompt open across a reload can't be seen from here; don't keep claiming it.
  delete me.waitingFor
  if (me.state === 'waiting' || me.state === 'asking') me.state = 'idle'
  await $.store.set(OWNER + id, INSTANCE)
  await resolveStatusPath($)
  me.tty = me.tty || (await findTty($))
  await refreshPlace($)
  await publish($)
}

// Same lookups the menu bar app runs: the tab whose tty is the session's. Only
// Terminal and iTerm2 expose a tab's tty to AppleScript.
const FOCUS_SCRIPTS = {
  Terminal: (tty) => `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        if miniaturized of w then set miniaturized of w to false
        set selected tab of w to t
        set index of w to 1
        activate
        return true
      end if
    end repeat
  end repeat
end tell
return false`,
  iTerm2: (tty) => `tell application id "com.googlecode.iterm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          tell w to select
          tell t to select
          tell s to select
          activate
          return true
        end if
      end repeat
    end repeat
  end repeat
end tell
return false`,
}

// Scripting a terminal that isn't running would launch it (or, uninstalled,
// raise a "Where is iTerm2?" dialog), so only running ones are asked.
async function isRunning($, name) {
  try {
    return (await $.process.run(['pgrep', '-xq', name])).exitCode === 0
  } catch {
    return false
  }
}

async function focusTab($, s) {
  if (!/^\/dev\/ttys\d+$/.test(s.tty || '')) return
  try {
    for (const [app, script] of Object.entries(FOCUS_SCRIPTS)) {
      if (!(await isRunning($, app))) continue
      const r = await $.process.run(['osascript', '-e', script(s.tty)])
      if (r.stdout.trim() === 'true') return true
    }
    $.ui.toast(`Couldn't find the tab for ${label(s)}`)
  } catch {
    $.ui.toast(`Couldn't switch to ${label(s)}`)
  }
  return false
}

function card({ Box, Text }, s, width) {
  const st = STATES[s.state] || STATES.idle
  const glyph = st.glyph || SPIN[frame % SPIN.length]
  const isMe = s.id === me.id
  const age = fmtAge(now() - (s.since || now()))
  const agents = s.agents || []
  const live = agents.filter((a) => AGENT_LIVE.has(a.status))
  const finished = agents.filter((a) => a.status === 'completed' || a.status === 'failed' || a.status === 'killed')
  const failed = agents.filter((a) => a.status === 'failed').length
  const inner = width - 4

  const row = (key, children) => Box({ key, flexDirection: 'row', children })
  const field = (key, name, value, props = {}) =>
    row(key, [
      Text({ dimColor: true, children: [name.padEnd(6)] }),
      Text({ wrap: 'truncate-end', ...props, children: [value] }),
    ])

  const header = row('h', [
    st.loud
      ? Text({ color: 'black', backgroundColor: st.color, bold: true, children: [` ${glyph} ${st.word} `] })
      : Text({ color: st.color, bold: true, children: [`${glyph} ${st.word}`] }),
    Text({ dimColor: true, children: [' ' + age] }),
    Box({ flexGrow: 1 }),
    ...(isMe ? [Text({ color: 'magenta', bold: true, children: ['● this tab'] })] : []),
  ])

  const title = Text({ bold: true, wrap: 'truncate-end', children: [label(s)] })

  const working = s.state === 'working' || s.state === 'waiting' || s.state === 'asking'
  const task = field('task', 'Task', s.task ? s.task : 'No task yet', { dimColor: !s.task })
  const shells = s.state === 'shells' ? s.shells || [] : []
  const now_ =
    s.state === 'waiting' && s.waitingFor
      ? field('now', 'Now', s.waitingFor, { color: 'yellow', bold: true })
      : shells.length
        ? field('now', 'Now', `Waiting on ${shells.length} background shell${shells.length === 1 ? '' : 's'}`, { color: 'blue', bold: true })
        : field('now', 'Now', working ? s.activity || 'Thinking…' : '—', { dimColor: !working, italic: working })

  const rows = [header, title, task, now_]
  for (const [i, sh] of shells.slice(0, AGENT_ROWS).entries()) {
    rows.push(
      row('sh-' + i, [
        Text({ dimColor: true, children: [(i === 0 ? 'Shells' : '').padEnd(6)] }),
        Text({ color: 'blue', children: [SPIN[frame % SPIN.length] + ' '] }),
        Text({ wrap: 'truncate-end', children: [shellText(sh)] }),
      ]),
    )
  }
  if (shells.length > AGENT_ROWS) {
    rows.push(Text({ key: 'sh-more', dimColor: true, children: [`      +${shells.length - AGENT_ROWS} more`] }))
  }

  if (agents.length === 0) {
    rows.push(field('ag', 'Agents', 'none', { dimColor: true }))
  } else {
    const total = agents.length
    const slots = 10
    const filled = Math.round((finished.length / total) * slots)
    rows.push(
      row('ag', [
        Text({ dimColor: true, children: ['Agents'.padEnd(6)] }),
        Text({ color: 'green', children: ['█'.repeat(filled)] }),
        Text({ dimColor: true, children: ['░'.repeat(slots - filled)] }),
        Text({ bold: true, children: [` ${finished.length}/${total} done`] }),
        ...(live.length ? [Text({ color: 'cyan', children: [` · ${live.length} running`] })] : []),
        ...(failed ? [Text({ color: 'red', children: [` · ${failed} failed`] })] : []),
      ]),
    )
    // Running agents first: they're the ones still worth reading about.
    const shown = [...live, ...agents.filter((a) => !AGENT_LIVE.has(a.status))].slice(0, AGENT_ROWS)
    for (const a of shown) {
      const [g, c] = AGENT_LIVE.has(a.status) ? [SPIN[frame % SPIN.length], 'cyan'] : AGENT_GLYPH[a.status] || ['∙', 'gray']
      rows.push(
        row('a-' + a.id, [
          Text({ children: ['      '] }),
          Text({ color: c, children: [g + ' '] }),
          Text({ wrap: 'truncate-end', dimColor: !AGENT_LIVE.has(a.status), children: [`${a.description || a.type}`] }),
          Text({ dimColor: true, wrap: 'truncate-end', children: [a.description ? `  ${a.type}` : ''] }),
        ]),
      )
    }
    if (agents.length > AGENT_ROWS) {
      rows.push(Text({ key: 'more', dimColor: true, children: [`      +${agents.length - AGENT_ROWS} more`] }))
    }
  }

  return Box({
    key: 'card-' + s.id,
    flexDirection: 'column',
    width,
    minWidth: Math.min(width, MIN_CARD),
    borderStyle: st.loud || isMe ? 'bold' : 'round',
    borderColor: st.loud ? st.color : isMe ? 'magenta' : 'gray',
    borderDimColor: !st.loud && !isMe,
    paddingX: 1,
    overflow: 'hidden',
    children: rows.map((r) => Box({ width: inner, overflow: 'hidden', children: [r] })),
  })
}

// Stop and SubagentStop are the only events that list the session's in-flight
// background work. A finished shell wakes the session with a notification turn,
// whose own Stop then carries the shorter list, so no other upkeep is needed.
// Their order against turn.complete isn't documented, so both settle.
async function trackShells($, e, next) {
  if (me && Array.isArray(e.background_tasks)) {
    me.shells = e.background_tasks
      .filter((t) => t.type === 'shell')
      .map((t) => ({ description: oneLine(t.description, 80), command: oneLine(t.command, 120) }))
    settle($)
    publish($).catch(() => {})
    $.ui.invalidate('ui.render')
  }
  return next(e)
}

// A /config change to `deck` reloads the module with the new options, so this
// is read once per load.
let deck = true

export function register(on, options = {}) {
  deck = options.deck !== false

  // The band's Buttons never receive a press in this terminal, so jumping to a
  // session is a command: /tab <text> picks the session whose project or ticket
  // matches, /tab <letter> one from the list a bare /tab prints, and a bare /tab
  // with only one other session goes straight there.
  on('command.run', { command: 'tab' }, async ($, e) => {
    const others = peers.map((s, i) => ({ s, letter: String.fromCharCode(97 + i) })).filter(({ s }) => s.id !== me?.id && s.tty)
    const arg = String(e.args || '').trim().toLowerCase()
    const hit =
      (arg.length === 1 && others.find((o) => o.letter === arg)) ||
      (arg && others.find((o) => label(o.s).toLowerCase().includes(arg))) ||
      (!arg && others.length === 1 && others[0])
    if (!hit) {
      const list = others.map((o) => `${o.letter}: ${label(o.s)}`).join(', ')
      return { text: others.length ? `Which session? ${list}` : 'No other Claude session with a terminal tab.' }
    }
    const switched = await focusTab($, hit.s)
    return { text: switched ? `Switched to ${label(hit.s)}.` : `Couldn't switch to ${label(hit.s)}.` }
  })

  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'tab', description: "Jump to another Claude session's terminal tab: /tab <project or ticket>, or /tab to list them" })
      .catch(() => {})
    await start($)
    $.clock.every(TICK_MS, () => tick($))
    $.clock.every(BEAT_MS, () => publish($).catch(() => {}))
    $.clock.every(PLACE_MS, () => refreshPlace($).catch(() => {}))
    return next(e)
  })

  // /clear, /resume and /branch end one conversation and start another under a
  // new id without firing session.start again. classic.SessionStart would say
  // so directly, but an organization policy can skip user mods on classic.*.
  on('session.end', async ($, e, next) => {
    if (me) {
      await $.store.delete(KEY + me.id).catch(() => {})
      await $.store.delete(OWNER + me.id).catch(() => {})
    }
    me = null
    asks.clear()
    calls.clear()
    mainActive = false
    endState = 'idle'
    settledBefore = new Set()
    if (e.reason === 'clear' || e.reason === 'resume') $.clock.after(500, () => start($).catch(() => {}))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    mainActive = true
    // An empty text is a continuation of the same task, not a new one; a text
    // opening on a tag (<agent-message>, <task-notification>) is the engine
    // handing a subagent's result back, not something you asked for.
    const text = (e.text || '').trim()
    if (me && text && !text.startsWith('<')) {
      me.task = oneLine(text, 160)
      retitle($, text)
      try {
        settledBefore = new Set((await $.agent.list()).filter((a) => !AGENT_LIVE.has(a.status)).map((a) => a.id))
      } catch {}
      me.agents = []
    }
    setActivity($, 'Thinking…')
    if (!blocked()) setState($, 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Subagent loops complete turns of their own; only the main loop's end
    // means the session is back in your hands.
    if (!e.agentId) {
      mainActive = false
      endState = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'error'
      setActivity($, '')
      // A background subagent can still be holding a prompt open after the main
      // loop has answered; that prompt outranks "done".
      settle($)
    }
    return next(e)
  })

  on('classic.Stop', trackShells)
  on('classic.SubagentStop', trackShells)

  // An 'ask' verdict only means the mode's decider gets the call: auto mode's
  // classifier, a PermissionRequest hook, or you. Guessing from the verdict plus
  // a timer flagged long subagent commands the classifier had quietly settled,
  // so the ask is just recorded here and promoted from classic.PermissionRequest,
  // which fires only when the engine raises the dialog. tool.check runs inside
  // tool.call's next(), so tool.call's finally retires the ask either way.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // The engine can re-check a prompt that's already up; re-recording it would
    // demote it until the timer fired again.
    if (verdict?.decision === 'ask' && e.tool_use_id && !asks.has(e.tool_use_id)) {
      asks.set(e.tool_use_id, { tool: e.tool, agentId: calls.get(e.tool_use_id)?.agentId, rule: verdict.rule, shown: false, promoted: false })
    }
    return verdict
  })

  // The request carries no tool_use_id, so it's matched to the oldest unshown
  // ask from the same loop for the same tool.
  on('classic.PermissionRequest', async ($, e, next) => {
    const sameTool = [...asks.entries()].filter(([, a]) => !a.shown && a.tool === e.tool_name)
    const match = sameTool.find(([, a]) => (a.agentId || undefined) === (e.agent_id || undefined)) || sameTool[0]
    // Auto mode prompts only on an explicit ask rule; anything else is the
    // classifier's to settle, however long the command then runs.
    if (match && (e.permission_mode !== 'auto' || match[1].rule)) {
      const [id, ask] = match
      ask.shown = true
      $.clock.after(ASK_GRACE_MS, () => {
        if (asks.get(id) !== ask || !me) return
        ask.promoted = true
        me.waitingFor = waitingText(calls.get(id), ask.tool)
        if (me.state === 'waiting') publish($).catch(() => {})
        else setState($, 'waiting')
        $.ui.invalidate('ui.render')
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isQuestion = e.tool === 'AskUserQuestion'
    if (isQuestion) setState($, 'asking')
    if (e.tool_use_id) calls.set(e.tool_use_id, { agentId: e.agentId, what: describeTool(e) })
    // Subagents' tools are summarised by the agent rows; the Now line tracks the main loop.
    if (!e.agentId) setActivity($, oneLine(describeTool(e), 120))
    try {
      return await next(e)
    } finally {
      // Only the call that raised the prompt (or the question) can retire it;
      // background subagents finish other tools all the time.
      const wasAsk = asks.delete(e.tool_use_id)
      calls.delete(e.tool_use_id)
      if (me && (isQuestion || wasAsk) && (me.state === 'waiting' || me.state === 'asking') && !blocked()) {
        me.waitingFor = undefined
        setState($, mainActive ? 'working' : settledState())
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!deck || !me || e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const cols = Math.max(MIN_CARD, (e.props.bodyColumns || 120) - 1)
    const theirs = await next(e)

    const list = peers.length ? peers : [{ ...me }]
    const perRow = Math.max(1, Math.min(list.length, Math.floor((cols + GAP) / (MIN_CARD + GAP))))
    const width = Math.floor((cols - GAP * (perRow - 1)) / perRow)

    const loud = list.filter((s) => STATES[s.state]?.loud).length
    const busy = list.filter((s) => s.state === 'working').length
    const shelled = list.filter((s) => s.state === 'shells').length
    const summary = Box({
      key: 'summary',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ bold: true, children: [`Sessions (${list.length})`] }),
        ...(busy ? [Text({ color: 'cyan', children: [`${busy} working`] })] : []),
        ...(shelled ? [Text({ color: 'blue', children: [`${shelled} with shells running`] })] : []),
        ...(loud ? [Text({ color: 'yellow', bold: true, children: [`${loud} need${loud === 1 ? 's' : ''} you`] })] : []),
      ],
    })

    const grid = Box({
      key: 'grid',
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: GAP,
      children: list.map((s) => card(ui, s, width)),
    })

    return Box({ flexDirection: 'column', children: [summary, grid, ...(theirs ? [theirs] : [])] })
  })
}
