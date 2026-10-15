import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HUB = '/home/me/.grove'
const WT = '/home/me/code/flux'
const REGISTRY = { name: 'flux', project: 'acme', path: WT, branch: 'me/flux', ports: { be: 5006, fe: 3001 }, agentNotes: 'Sign-in works on the fe port.' }

// a fake host beneath the plugin: files in memory, commands recorded
function host(on: On, env: Record<string, string> = {}) {
  const files = new Map<string, string>([[`${HUB}/projects/acme/flux/feature.json`, JSON.stringify(REGISTRY)]])
  const commands: string[][] = []

  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : env[e.name] }))
  on('fs.list', ($, e) => {
    // the direct children of e.path: a file, or a folder some file sits beneath
    const children = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (path.startsWith(`${e.path}/`)) {
        const [head, ...rest] = path.slice(e.path.length + 1).split('/')
        if (head !== undefined) {
          children.set(head, rest.length > 0 ? 'dir' : 'file')
        }
      }
    }

    return { value: [...children].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    commands.push([...e.argv])
    if (e.argv[0] === 'sh') {
      return { value: { exitCode: 0, stdout: '4242\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    const stdout = e.argv[1] === 'findings' ? 'The review bots left 1 comment(s)\nFor each one:\n- fix it' : `ran ${e.argv.slice(1).join(' ')}`

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const clock = mock.clock(on, { now: 1000 })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__grove__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const submitted: string[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })

  const status = () => JSON.parse(files.get(`${HUB}/projects/acme/flux/status.json`) ?? '{}')

  return { files, commands, status, submitted, clock }
}

test('a session in a feature worktree publishes its state', async ($, on) => {
  const fake = host(on)
  on('classic.Notification', () => ({}))

  await $.session.start({ cwd: `${WT}/api`, surface: null, isInteractive: true })
  expect(fake.status().state).toBe('ready')

  await $.classic.Notification({ message: 'Claude needs permission to use Bash', notification_type: 'permission_prompt' })
  expect(fake.status().state).toBe('waiting')
  expect(fake.status().message).toBe('Claude needs permission to use Bash')
  expect(fake.commands.some(argv => argv[0] === 'osascript')).toBe(true)
})

test('a session row without a conversation yet is found by its folder', async ($, on) => {
  const fake = host(on)
  const scratch = `${HUB}/projects/acme/fix-import-acme/worktree`
  fake.files.set(`${HUB}/projects/acme/fix-import-acme/feature.json`,
    JSON.stringify({ name: 'fix-import-acme', kind: 'session', helper: 'import', project: 'acme', path: scratch, branch: '', ports: {} }))

  await $.session.start({ cwd: scratch, surface: null, isInteractive: true })
  expect(JSON.parse(fake.files.get(`${HUB}/projects/acme/fix-import-acme/status.json`) ?? '{}').state).toBe('ready')
})

test('GROVE_HUB and GROVE_BIN point a session at another hub', async ($, on) => {
  const fake = host(on, { GROVE_HUB: '/tmp/try/hub', GROVE_BIN: '/src/cli/grove' })
  fake.files.set('/tmp/try/hub/projects/acme/flux/feature.json', JSON.stringify(REGISTRY))
  fake.files.delete(`${HUB}/projects/acme/flux/feature.json`)

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  expect(JSON.parse(fake.files.get('/tmp/try/hub/projects/acme/flux/status.json') ?? '{}').state).toBe('ready')
  expect(fake.files.has(`${HUB}/projects/acme/flux/status.json`)).toBe(false)

  const origin = { kind: 'composer' as const }
  await $.command.run({ command: 'feature', args: '', origin, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(fake.commands).toContainEqual(['/src/cli/grove', 'ls'])
})

test('/feature routes to grove', async ($, on) => {
  const fake = host(on)

  await $.session.start({ cwd: '/elsewhere', surface: null, isInteractive: true })
  const presentation = { isFullscreen: false, columns: 120 }
  const origin = { kind: 'composer' as const }

  await $.command.run({ command: 'feature', args: 'flux', origin, presentation } as never)
  await $.command.run({ command: 'feature', args: 'new metering-v2 origin/main', origin, presentation } as never)
  await $.command.run({ command: 'feature', args: '', origin, presentation } as never)

  const cli = `${HUB}/bin/grove`
  expect(fake.commands).toContainEqual([cli, 'go', 'flux'])
  expect(fake.commands).toContainEqual([cli, 'new', 'metering-v2', 'origin/main'])
  expect(fake.commands).toContainEqual([cli, 'ls'])
  // not inside a feature worktree: nothing published
  expect(fake.files.has(`${HUB}/projects/acme/flux/status.json`)).toBe(false)
})

test('a feature session learns its ports and can hand off review findings', async ($, on) => {
  const fake = host(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const mine = composed.sections.find(section => section.id === 'grove:context')
  expect(mine?.text).toContain('http://localhost:3001')
  expect(mine?.text).toContain('http://localhost:5006')
  expect(mine?.text).toContain('Sign-in works on the fe port.')

  const origin = { kind: 'composer' as const }
  const presentation = { isFullscreen: false, columns: 120 }
  await $.command.run({ command: 'feature', args: 'address', origin, presentation } as never)
  expect(fake.commands).toContainEqual([`${HUB}/bin/grove`, 'findings', 'flux', '--brief', '--mark'])
  await fake.clock.advance(200)
  expect(fake.submitted[0]).toContain('For each one:')
})

test('inside tmux the window header says what, next step and facts', async ($, on) => {
  const fake = host(on, { TMUX_PANE: '%1' })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Fix the totals row rounding', toolUses: [] },
      { role: 'assistant', text: 'Patched the reducer; tests next', toolUses: [] },
    ],
  }) as never)
  on('model.complete', () => ({
    value: { isAnswered: true, text: '{"work": "fix totals rounding", "now": "patch written", "next": "run the jest suite"}', usage: {} },
  }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await fake.clock.advance(100)

  const paints = fake.commands.filter(argv => argv.includes('@grove_h1'))
  const last = paints.at(-1) ?? []
  const line1 = last[last.indexOf('@grove_h1') + 1] ?? ''
  const line2 = last[last.indexOf('@grove_h2') + 1] ?? ''
  const line3 = last[last.indexOf('@grove_h3') + 1] ?? ''
  // identity, a state that carries a word, and the next step
  expect(line1).toContain('flux')
  // the stage track names the current stage and its position
  expect(line3).toMatch(/[A-Z][a-z]+ \d\/8/)
  expect(last).toContain('@grove_fill')
  expect(line1).toContain('YOUR TURN')
  expect(line1).toContain('NEXT ▸')
  expect(line1).toContain('run the jest suite')
  // the recap and the facts
  expect(line2).toContain('fix totals rounding')
  expect(line2).toContain('patch written')
  expect(line2).toContain('no PR')
  expect(line2).toContain('fe :3001')
})

test('Claude can spin off a related feature with a handover', async ($, on) => {
  const fake = host(on)

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  const made = await $.tool.call({
    tool: 'mcp__grove__new_feature',
    name: 'csv-export',
    title: 'CSV export for variance',
    task: 'Add a CSV export to the variance report.',
    context: 'Totals now round once on the sum (totals.py); reuse that helper.',
    base: 'current',
  } as never)

  const argv = fake.commands.find(a => a[1] === 'new') ?? []
  expect(argv.slice(1, 3)).toEqual(['new', 'csv-export'])
  expect(argv).toContain('--title')
  expect(argv[argv.indexOf('--parent') + 1]).toBe('flux')
  expect(argv[argv.indexOf('--base') + 1]).toBe('me/flux')
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  expect(prompt).toContain('Add a CSV export')
  expect(prompt).toContain('Context handed over from feature flux')
  expect(prompt).toContain('totals.py')
  expect(JSON.stringify(made)).toContain('ran new csv-export')
})

test('a main-checkout session is matched by its id, not its folder', async ($, on) => {
  const fake = host(on)
  const repo = '/home/me/code/acme'
  fake.files.set(`${HUB}/projects/acme/s-sess1/feature.json`, JSON.stringify({ name: 's-sess1', kind: 'session', session: 'sess-1', project: 'acme', path: repo, branch: 'main', ports: {} }))
  fake.files.set(`${HUB}/projects/acme/s-other/feature.json`, JSON.stringify({ name: 's-other', kind: 'session', session: 'sess-2', project: 'acme', path: repo, branch: 'main', ports: {} }))

  await $.session.start({ cwd: repo, surface: null, isInteractive: true })

  expect(fake.files.has(`${HUB}/projects/acme/s-sess1/status.json`)).toBe(true) // this conversation (session.id is sess-1)
  expect(fake.files.has(`${HUB}/projects/acme/s-other/status.json`)).toBe(false) // same folder, another conversation
})

test('a working session asks grove to keep the Mac awake', async ($, on) => {
  const fake = host(on)
  on('turn.start', ($, e) => e)

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  expect(fake.commands).not.toContainEqual([`${HUB}/bin/grove`, 'keepawake'])

  await $.turn.start({ turnId: 't1' } as never)
  expect(fake.status().state).toBe('working')
  expect(fake.commands).toContainEqual([`${HUB}/bin/grove`, 'keepawake'])
})

test('each feature reports into its own folder, whatever project it is in', async ($, on) => {
  const fake = host(on)
  const other = '/home/me/code/beta'
  fake.files.set(`${HUB}/projects/acme/project.json`, JSON.stringify({ repo: '~/code/acme' }))
  fake.files.set(`${HUB}/projects/zeta/project.json`, JSON.stringify({ repo: '~/code/zeta' }))
  fake.files.set(`${HUB}/projects/zeta/beta/feature.json`, JSON.stringify({ name: 'beta', project: 'zeta', path: other, branch: 'me/beta', ports: {} }))

  await $.session.start({ cwd: other, surface: null, isInteractive: true })

  expect(JSON.parse(fake.files.get(`${HUB}/projects/zeta/beta/status.json`) ?? '{}').state).toBe('ready')
  expect(fake.files.has(`${HUB}/projects/acme/flux/status.json`)).toBe(false)
})

test('a finished turn asks grove to refresh the recap', async ($, on) => {
  const fake = host(on)
  on('turn.start', ($, e) => e)
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)
  fake.commands.length = 0
  await $.turn.complete({ turnId: 't1', answer: 'Added the button.', durationMs: 5, isAborted: false } as never)

  expect(fake.status().state).toBe('ready')
  expect(fake.commands).toContainEqual([`${HUB}/bin/grove`, 'recap', 'flux', '--bg'])
})

test('tmux commands that would reach the live server are blocked', async ($, on) => {
  host(on)
  let ran = 0
  on('tool.call', { tool: 'Bash' }, () => {
    ran += 1

    return { result: 'ok' }
  })
  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as never)

  // the 2026-10-14 accident: TMUX_TMPDIR without unsetting TMUX, then kill-server
  const blocked = await bash('export T=/tmp/gr && mkdir -p $T/tm && export TMUX_TMPDIR=$T/tm && tmux new-session -d -s x && tmux ls; tmux kill-server')
  expect(JSON.stringify(blocked)).toContain('live server')
  expect(JSON.stringify(await bash('tmux kill-server'))).toContain('kill-server')
  expect(ran).toBe(0)

  await bash('env -u TMUX TMUX_TMPDIR=/tmp/x/tm tmux new-session -d -s t && unset TMUX && TMUX_TMPDIR=/tmp/x/tm tmux kill-server')
  await bash('tmux -S /tmp/x/sock new-session -d -s t; tmux -S /tmp/x/sock kill-server')
  await bash('tmux ls; tmux capture-pane -p -S -20 -t grove_flux_claude')
  await bash('git status')
  expect(ran).toBe(4)
})

test('a closed feature gets no status file back', async ($, on) => {
  const fake = host(on)
  on('classic.Notification', () => ({}))

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  expect(fake.status().state).toBe('ready')

  // grove done removes the folder while this session is still shutting down
  for (const path of [...fake.files.keys()]) {
    if (path.startsWith(`${HUB}/projects/acme/flux/`)) {
      fake.files.delete(path)
    }
  }
  await $.classic.Notification({ message: 'Claude needs permission to use Bash', notification_type: 'permission_prompt' })
  expect(fake.files.has(`${HUB}/projects/acme/flux/status.json`)).toBe(false)
})

test('the status names the Claude process, so a session that is gone shows offline', async ($, on) => {
  const fake = host(on)

  await $.session.start({ cwd: WT, surface: null, isInteractive: true })
  expect(fake.status().pid).toBe(4242)
  expect(fake.commands.some(argv => argv[0] === 'sh' && argv[2]?.includes('ps -o comm='))).toBe(true)
})
