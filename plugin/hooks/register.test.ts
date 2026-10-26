import { test, expect, mock } from 'claude-code/testing'

const BAND = {
  plugin: 'session-tower',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

const runs: string[][] = []

function arrange(on: any, store: Record<string, unknown> = {}, terminals: string[] = ['Terminal']) {
  const engine = on as unknown as (event: string, hook: (...a: any[]) => unknown) => void
  engine('session.start', () => ({ cwd: '/tmp' }))
  engine('session.id', () => ({ value: 'abc123' }))
  engine('session.cwd', () => ({ value: '/tmp/groups' }))
  engine('env.get', () => ({ value: '/Users/tester' }))
  runs.length = 0
  engine('process.run', ($: unknown, e: { argv?: string[] }) => {
    runs.push(e.argv ?? [])
    if (e.argv?.[0] === 'pgrep') return { value: { exitCode: terminals.includes(e.argv[2] ?? '') ? 0 : 1, stdout: '', stderr: '' } }
    const argv = String(e.argv ?? '')
    const stdout = argv.startsWith('osascript,') ? 'true\n' : argv.startsWith('sh,') ? '/dev/ttys004\n' : argv.includes('branch') ? 'task_AP-45272_x' : '/tmp/groups'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  mock.store(on, store)
  const clock = mock.clock(on, { now: 1_000_000 })
  engine('agent.list', () => ({
    value: [
      { id: 'a1', description: 'Find hook manifests', type: 'Explore', status: 'running' },
      { id: 'a2', description: 'Review the diff', type: 'general-purpose', status: 'completed' },
    ],
  }))
  engine('turn.start', ($: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  engine('ui.invalidate', () => ({ value: undefined }))
  engine('command.register', () => ({ value: undefined }))
  engine('model.complete', () => ({ value: { isAnswered: true, text: '"Run The Test Suite."' } }))
  engine('ui.render', ($: any, e: unknown) => $.ui.resolve(e).Box({}))
  return clock
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`card shows task, current step and status on ${surface}`, async ($, on) => {
    const clock = arrange(on)
    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.session.start({ cwd: '/tmp' } as never)
    await $.turn.start({ text: 'Make the session deck a grid', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/a/b/register.js' } as never)
    await clock.advance(1000)

    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(await ui.find({ text: /Working/ })).toBeDefined()
    expect(await ui.find({ text: /Make the session deck a grid/ })).toBeDefined()
    expect(await ui.find({ text: /Reading register\.js/ })).toBeDefined()
    expect(await ui.find({ text: /0\/1 done/ })).toBeDefined()
    // Finished before this task began: belongs to an earlier task, so hidden.
    expect(await ui.find({ text: /Review the diff/ })).toBeUndefined()
    expect(await ui.find({ text: /1 running/ })).toBeDefined()
    expect(await ui.find({ text: /Find hook manifests/ })).toBeDefined()
    expect(await ui.find({ text: /ctx|5h|\$\d/ })).toBeUndefined()
  })
}

const PROMPT = (tool: string, extra: Record<string, unknown> = {}) =>
  ({ hook_event_name: 'PermissionRequest', session_id: 'abc123', transcript_path: '/t', cwd: '/tmp', permission_mode: 'default', tool_name: tool, tool_input: {}, ...extra }) as never

function arrangeAsk(on: any, verdict: { decision: 'ask'; rule?: string } = { decision: 'ask' }) {
  const clock = arrange(on)
  const engine = on as unknown as (event: string, hook: (...a: any[]) => unknown) => void
  engine('tool.check', () => verdict)
  engine('turn.complete', () => ({ text: '' }))
  engine('classic.PermissionRequest', () => ({}))
  return clock
}

async function startTurn($: any) {
  await $.session.start({ cwd: '/tmp' })
  await $.turn.start({ text: 'Run the tests', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', command: 'make test', tool_use_id: 'u1' })
}

test('an ask settled within the grace period never shows Needs approval', async ($, on) => {
  const clock = arrangeAsk(on)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await startTurn($)
  await $.classic.PermissionRequest(PROMPT('Bash'))
  await clock.advance(500)
  await $.tool.call({ tool: 'Bash', command: 'make test', tool_use_id: 'u1' } as never)
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Needs approval/ })).toBeUndefined()
  expect(await ui.find({ text: /Working/ })).toBeDefined()
})

test('a dialog still open after the grace period shows Needs approval', async ($, on) => {
  const clock = arrangeAsk(on)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await startTurn($)
  await $.classic.PermissionRequest(PROMPT('Bash'))
  await clock.advance(1500)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Needs approval/ })).toBeUndefined()
  await ui.unmount()
  await clock.advance(1000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Needs approval/ })).toBeDefined()
})

test('an ask that never raises a dialog never shows Needs approval, however long it runs', async ($, on) => {
  const clock = arrangeAsk(on)
  let finish: () => void = () => {}
  on('tool.call', (async () => {
    await new Promise<void>((resolve) => (finish = resolve))
    return { result: 'ok' }
  }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Review PR 11042', turnId: 't1' })
  const pending = $.tool.call({ tool: 'Bash', command: 'diff a b', description: 'Compare route trees', tool_use_id: 'u7', agentId: 'a1' } as never)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u7' } as never)
  await clock.advance(60_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Needs approval/ })).toBeUndefined()
  expect(await ui.find({ text: /needs you/ })).toBeUndefined()
  await ui.unmount()
  finish()
  await pending
})

test('a subagent prompt after the main turn finished shows Needs approval, not Done', async ($, on) => {
  const clock = arrangeAsk(on)
  let approve: () => void = () => {}
  // As in a session, the permission check runs while the tool call is pending,
  // and the call stays pending until the person answers.
  on('tool.call', (async () => {
    await new Promise<void>((resolve) => (approve = resolve))
    return { result: 'ok' }
  }) as never)

  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Review PR 11042', turnId: 't1' })
  await clock.advance(1000)
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok' } as never)
  await $.turn.start({ text: '<agent-message from="af117">[Subagent hand-back]</agent-message>', turnId: 't2' })
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't2', answer: 'ok' } as never)

  const pending = $.tool.call({ tool: 'Bash', command: 'bash /tmp/run-gates.sh', description: 'Run static scanner gates', tool_use_id: 'u9', agentId: 'a1' } as never)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u9' } as never)
  await $.classic.PermissionRequest(PROMPT('Bash', { agent_id: 'a1' }))
  await clock.advance(2500)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Needs approval/ })).toBeDefined()
  expect(await ui.find({ text: /Done/ })).toBeUndefined()
  expect(await ui.find({ text: /Approve: running Run static scanner gates · from Find hook manifests/ })).toBeDefined()
  expect(await ui.find({ text: /Review PR 11042/ })).toBeDefined()
  expect(await ui.find({ text: /agent-message/ })).toBeUndefined()
  await ui.unmount()

  approve()
  await pending
  await clock.advance(1000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Needs approval/ })).toBeUndefined()
  expect(await ui.find({ text: /Done/ })).toBeDefined()
})

test('Needs approval holds while the prompt is re-checked and other tools finish', async ($, on) => {
  const clock = arrangeAsk(on)
  let approve: () => void = () => {}
  on('tool.call', (async (_$: unknown, e: any) => {
    if (e.tool_use_id === 'u9') await new Promise<void>((resolve) => (approve = resolve))
    return { result: 'ok' }
  }) as never)

  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Review PR 11042', turnId: 't1' })
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok' } as never)

  const pending = $.tool.call({ tool: 'Bash', command: 'bash /tmp/x.sh', tool_use_id: 'u9', agentId: 'a1' } as never)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u9' } as never)
  await $.classic.PermissionRequest(PROMPT('Bash', { agent_id: 'a1' }))
  await clock.advance(2500)
  for (let i = 0; i < 5; i++) {
    await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u9' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/a/b.ts', tool_use_id: 'r' + i, agentId: 'a1' } as never)
    await clock.advance(1000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await ui.find({ text: /Needs approval/ })).toBeDefined()
    expect(await ui.find({ text: /Done/ })).toBeUndefined()
    await ui.unmount()
  }

  approve()
  await pending
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Done/ })).toBeDefined()
})

async function autoModeDialog($: any, on: any, verdict: { decision: 'ask'; rule?: string }) {
  const clock = arrangeAsk(on, verdict)
  let finish: () => void = () => {}
  on('tool.call', (async () => {
    await new Promise<void>((resolve) => (finish = resolve))
    return { result: 'ok' }
  }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Review PR 11042', turnId: 't1' })
  const pending = $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'u7', agentId: 'a1' } as never)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u7' } as never)
  await $.classic.PermissionRequest(PROMPT('Bash', { agent_id: 'a1', permission_mode: 'auto' }))
  await clock.advance(30_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  const shown = await ui.find({ text: /Needs approval/ })
  await ui.unmount()
  finish()
  await pending
  return shown
}

test('in auto mode a rule-less ask is the classifier\'s, never Needs approval', async ($, on) => {
  expect(await autoModeDialog($, on, { decision: 'ask' })).toBeUndefined()
})

test('in auto mode an explicit ask rule still shows Needs approval', async ($, on) => {
  expect(await autoModeDialog($, on, { decision: 'ask', rule: 'Bash(git push:*)' })).toBeDefined()
})

test('every session is mirrored to ~/.claude/claude-tower-status.json for the menu bar app', async ($, on) => {
  const clock = arrangeAsk(on)
  const writes: { path: string; text: string }[] = []
  const engine = on as unknown as (event: string, hook: (...a: any[]) => unknown) => void
  engine('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    writes.push(e)
    return { value: undefined }
  })
  let approve: () => void = () => {}
  on('tool.call', (async () => {
    await new Promise<void>((resolve) => (approve = resolve))
    return { result: 'ok' }
  }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Run the tests', turnId: 't1' })
  const pending = $.tool.call({ tool: 'Bash', command: 'make test', description: 'Run tests', tool_use_id: 'u1' } as never)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1' } as never)
  await $.classic.PermissionRequest(PROMPT('Bash'))
  await clock.advance(3000)

  const last = writes.filter((w) => w.path.endsWith('/.claude/claude-tower-status.json')).at(-1)
  expect(last).toBeDefined()
  const snap = JSON.parse(last!.text)
  expect(snap.version).toBe(1)
  expect(snap.sessions).toHaveLength(1)
  expect(snap.sessions[0]).toMatchObject({ project: 'groups', branch: 'task_AP-45272_x', state: 'waiting', task: 'Run the tests', tty: '/dev/ttys004', title: 'Run The Test Suite' })
  expect(snap.sessions[0].waitingFor).toMatch(/Approve: running Run tests/)
  approve()
  await pending
})

test('with the deck off, the band draws nothing but the menu bar app still gets every session', { options: { deck: false } }, async ($, on) => {
  const clock = arrange(on)
  const writes: { path: string; text: string }[] = []
  const engine = on as unknown as (event: string, hook: (...a: any[]) => unknown) => void
  engine('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    writes.push(e)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Make the session deck a grid', turnId: 't1' })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /Working/ })).toBeUndefined()
  expect(await ui.find({ text: /Sessions \(/ })).toBeUndefined()
  const snap = JSON.parse(writes.filter((w) => w.path === '/Users/tester/.claude/claude-tower-status.json').at(-1)!.text)
  expect(snap.sessions[0]).toMatchObject({ state: 'working', task: 'Make the session deck a grid' })
})

const STOP = (tasks: Record<string, unknown>[]) =>
  ({ hook_event_name: 'Stop', session_id: 'abc123', transcript_path: '/t', cwd: '/tmp', stop_hook_active: false, background_tasks: tasks }) as never

const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'Run the parallel suite', command: 'make server.test.parallel.all' }

function arrangeStop(on: any) {
  const clock = arrange(on)
  const engine = on as unknown as (event: string, hook: (...a: any[]) => unknown) => void
  engine('turn.complete', () => ({ text: '' }))
  engine('classic.Stop', () => ({}))
  return clock
}

for (const order of ['stop-first', 'complete-first'] as const) {
  test(`a turn that ends with a shell still running reads "shells running", not Done (${order})`, async ($, on) => {
    const clock = arrangeStop(on)
    await $.session.start({ cwd: '/tmp' } as never)
    await $.turn.start({ text: 'Run the suite in the background', turnId: 't1' })
    const complete = () => $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok' } as never)
    // A subagent stopping in the background lists the same shells.
    if (order === 'stop-first') {
      await $.classic.Stop(STOP([SHELL, { id: 'a9', type: 'subagent', status: 'running', description: 'x' }]))
      await complete()
    } else {
      await complete()
      await $.classic.Stop(STOP([SHELL]))
    }
    await clock.advance(1000)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await ui.find({ text: /Done · shells running/ })).toBeDefined()
    expect(await ui.find({ text: /Waiting on 1 background shell$/ })).toBeDefined()
    expect(await ui.find({ text: /Run the parallel suite/ })).toBeDefined()
    expect(await ui.find({ text: /1 with shells running/ })).toBeDefined()
  })
}

test('once the shells end, the session reads Done again', async ($, on) => {
  const clock = arrangeStop(on)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Run the suite in the background', turnId: 't1' })
  await $.classic.Stop(STOP([SHELL]))
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok' } as never)
  // The shell's completion notification wakes the session for a turn of its own.
  await $.turn.start({ text: '<task-notification>b1 completed</task-notification>', turnId: 't2' })
  await $.classic.Stop(STOP([]))
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't2', answer: 'ok' } as never)
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ text: /shells running/ })).toBeUndefined()
  expect(await ui.find({ text: /✓ Done/ })).toBeDefined()
  expect(await ui.find({ text: /Run the suite in the background/ })).toBeDefined()
})

test('the status file carries the shells and the "shells" state for the menu bar app', async ($, on) => {
  const clock = arrangeStop(on)
  const writes: { path: string; text: string }[] = []
  const engine = on as unknown as (event: string, hook: (...a: any[]) => unknown) => void
  engine('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    writes.push(e)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'Run the suite in the background', turnId: 't1' })
  await $.classic.Stop(STOP([SHELL]))
  await $.turn.complete({ reason: 'answer', isAborted: false, turnId: 't1', answer: 'ok' } as never)
  await clock.advance(4000)
  const snap = JSON.parse(writes.filter((w) => w.path.endsWith('/.claude/claude-tower-status.json')).at(-1)!.text)
  expect(snap.sessions[0]).toMatchObject({ state: 'shells', shells: [{ description: 'Run the parallel suite', command: 'make server.test.parallel.all' }] })
})

test('/tab <ticket> jumps to the matching session when the band cannot be pressed', async ($, on) => {
  const clock = arrange(on, {
    'session:peer1': { id: 'peer1', project: 'groups', branch: 'task_AP-1_y', tty: '/dev/ttys007', state: 'working', since: Date.now(), startedAt: Date.now() + 1, beat: Date.now() },
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(1000)
  const out = await $.command.run({ command: 'tab', args: 'ap-1' } as never)
  expect(JSON.stringify(out)).toContain('Switched to groups · AP-1')
  expect(runs.find((argv) => argv[0] === 'osascript')!.join(' ')).toContain('"/dev/ttys007"')
})

test('/tab finds the session in iTerm2 when Terminal is not running', async ($, on) => {
  const clock = arrange(on, {
    'session:peer1': { id: 'peer1', project: 'groups', branch: 'task_AP-1_y', tty: '/dev/ttys007', state: 'working', since: Date.now(), startedAt: Date.now() + 1, beat: Date.now() },
  }, ['iTerm2'])
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(1000)
  const out = await $.command.run({ command: 'tab', args: 'ap-1' } as never)
  expect(JSON.stringify(out)).toContain('Switched to groups · AP-1')
  const scripts = runs.filter((argv) => argv[0] === 'osascript').map((argv) => argv.join(' '))
  expect(scripts).toHaveLength(1)
  expect(scripts[0]).toContain('com.googlecode.iterm2')
})
