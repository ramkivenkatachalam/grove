import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Feature, FeatureState, Pr } from '../types'

const features = atom({ plugin: 'grove', key: 'features' } as const, [])
const self = atom({ plugin: 'grove', key: 'self' } as const, null)
const isHidden = atom({ plugin: 'grove', key: 'isHidden' } as const, false)

const POLL_MS = 3000
const PR_TTL_MS = 180_000
const ICON: Record<FeatureState, string> = {
  waiting: '❗',
  ready: '✓',
  working: '⏳',
  offline: '·',
}
const CI_ICON: Record<Pr['ci'], string> = { pass: '✓', fail: '✗', running: '⟳', none: '' }
const NEEDS_YOU: FeatureState[] = ['waiting', 'ready']
const VERBS = ['ls', 'new', 'go', 'done', 'restart', 'up', 'down', 'clean', 'doctor', 'pr', 'findings']

type Registered = {
  name: string
  dir: string // its folder in the hub: projects/<project>/<name>, where status.json goes
  path: string
  branch: string
  ports?: Record<string, number>
  bePort?: number // registries from before projects
  fePort?: number
  ticket?: string | null
  project?: string
  agentNotes?: string
  kind?: 'session' // a conversation in the main checkout, matched by its id, not its folder
  session?: string
}

// a feature's services and their ports, e.g. { be: 5006, fe: 3001 }
const portsOf = (one: Registered): Record<string, number> =>
  one.ports ?? Object.fromEntries(Object.entries({ be: one.bePort, fe: one.fePort }).filter(([, v]) => v !== undefined)) as Record<string, number>
type Summary = { work: string; now: string; next: string }
type Status = { state: FeatureState; message: string; updatedAt: number; details?: Record<string, unknown> } & Partial<Summary>
type Git = { dirty: number; ahead: number; behind: number; stage: number | null; changed: string[] }

// the feature's lifecycle, as statusline-feature.sh tracked it; colours are xterm-256 fills
const STAGES = ['Explore', 'Design', 'Spec', 'Build', 'Verify', 'PR', 'Review', 'Merged']
// design A (the Grove canvas): words for each state; colours come from the palette
const STATE_WORD: Record<FeatureState, string> = {
  waiting: 'NEEDS YOU',
  ready: 'YOUR TURN',
  working: 'WORKING',
  offline: 'OFFLINE',
}
type Palette = { band: string; name: string; accent: string; waiting: string; working: string; ready: string }
const CLAUDE: Palette = { band: '#3a2822', name: '#d77757', accent: '#e8957a', waiting: '#ffc2a6', working: '#b8bccb', ready: '#8fdcb4' }
const TEXT = '#eeeeee'
const TEXT_2 = '#bcbcbc' // secondary text on the band, >= 7:1 on every palette
const RULE = '#8a8a8a' // separators: decoration only

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001'
const SUMMARY_GAP_MS = 60_000
const GIT_GAP_MS = 20_000
type PrCache = { fetchedAt?: number; byBranch?: Record<string, Omit<Pr, 'findings'> & { findings?: number }> }

const parse = <T,>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

let hub = ''
let cli = ''
let me: Registered | undefined
let myState: FeatureState = 'offline'
let lastSeen = new Map<string, FeatureState>()
let lastPr: Pr | null = null
let isSyncing = false
let pane: string | undefined
let summary: Summary = { work: '', now: '', next: '' }
let lastSummaryAt = Number.NEGATIVE_INFINITY
let git: Git = { dirty: 0, ahead: 0, behind: 0, stage: null, changed: [] }
let lastGitAt = Number.NEGATIVE_INFINITY
let lastHeader = ''
let details: Record<string, unknown> = {}
let lastMessage = ''
let turnStartedAt = 0
let lastWaitMessage = ''

function run($: EngineInterface, argv: string[]) {
  return $.process.run(argv, { timeoutMs: 300_000 }).catch(error => ({
    exitCode: 1,
    stdout: '',
    stderr: String(error),
  }))
}

async function notify($: EngineInterface, title: string, message: string) {
  await run($, [
    'osascript', '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`,
  ])
}

// the hub keeps one folder per project, and in it one folder per feature with its feature.json
async function readRegistry($: EngineInterface): Promise<Registered[]> {
  const projects = await $.fs.list(`${hub}/projects`).catch(() => [])
  const dirs = (await Promise.all(
    projects
      .filter(project => project.kind === 'dir')
      .map(project => $.fs.list(`${hub}/projects/${project.name}`).then(
        entries => entries.filter(entry => entry.kind === 'dir').map(entry => `${hub}/projects/${project.name}/${entry.name}`),
        () => [],
      )),
  )).flat()
  const rows = await Promise.all(
    dirs.map(dir => $.fs.read(`${dir}/feature.json`).then(
      text => {
        const row = parse<Registered>(text)

        return row === undefined ? undefined : { ...row, dir }
      },
      () => undefined,
    )),
  )

  return rows.filter((row): row is Registered => row !== undefined)
}

// the gh cache is shared: whichever session finds it stale refreshes it
async function syncPrs($: EngineInterface, cache: PrCache) {
  const now = await $.clock.now()
  if (isSyncing || now - (cache.fetchedAt ?? 0) * 1000 < PR_TTL_MS) {
    return
  }
  isSyncing = true
  await run($, [cli, 'pr'])
  isSyncing = false
}

async function watchMyPr($: EngineInterface, pr: Pr | null) {
  const before = lastPr
  lastPr = pr
  if (me === undefined || pr === null || before === null || before.number !== pr.number) {
    return
  }
  if (before.ci === 'running' && (pr.ci === 'pass' || pr.ci === 'fail')) {
    const text = `CI ${pr.ci === 'pass' ? 'passed' : 'failed'} on #${pr.number}`
    $.ui.toast(`${CI_ICON[pr.ci]} ${text}`)
    await notify($, `Claude · ${me.name}`, text)
  }
  if (pr.findings > before.findings) {
    const text = `${pr.findings} unanswered review-bot finding(s) on #${pr.number} — /feature address`
    $.ui.toast(`💬 ${text}`)
    await notify($, `Claude · ${me.name}`, text)
  }
}

async function refresh($: EngineInterface) {
  const registry = await readRegistry($)
  const cache = (await $.fs.read(`${hub}/prs.json`).then(parse<PrCache>, () => undefined)) ?? {}
  void syncPrs($, cache)
  const rows: Feature[] = await Promise.all(
    registry.map(async (one): Promise<Feature> => {
      const status = await $.fs
        .read(`${one.dir}/status.json`)
        .then(parse<Status>, () => undefined)
      const pr = cache.byBranch?.[one.branch]

      return {
        name: one.name,
        ports: portsOf(one),
        state: status?.state ?? 'offline',
        message: status?.message ?? '',
        updatedAt: status?.updatedAt ?? 0,
        pr: pr ? { ...pr, findings: pr.findings ?? 0 } : null,
      }
    }),
  )
  rows.sort((a, b) => a.name.localeCompare(b.name))

  // toast when another feature has just started needing you
  const isFirst = lastSeen.size === 0
  for (const row of rows) {
    const before = lastSeen.get(row.name)
    const isNew = NEEDS_YOU.includes(row.state) && before !== row.state
    if (!isFirst && isNew && row.name !== me?.name) {
      $.ui.toast(`${ICON[row.state]} ${row.name}: ${row.message || row.state} — /feature ${row.name}`)
    }
  }
  lastSeen = new Map(rows.map(row => [row.name, row.state]))
  await watchMyPr($, rows.find(row => row.name === me?.name)?.pr ?? null)
  await readGit($)
  await paintHeader($)
  await update($, features, () => rows)
}

// message: the state's message; left out, the last one written stands
async function writeStatus($: EngineInterface, message?: string) {
  if (me === undefined) {
    return
  }
  if (message !== undefined) {
    lastMessage = message
  }
  const status: Status = { state: myState, message: lastMessage, updatedAt: await $.clock.now(), ...summary, details }
  await $.fs.write(`${me.dir}/status.json`, JSON.stringify(status))
}

async function readGit($: EngineInterface) {
  const now = await $.clock.now()
  if (me === undefined || now - lastGitAt < GIT_GAP_MS) {
    return
  }
  lastGitAt = now
  const at = me.path
  const git_ = (...args: string[]) => run($, ['git', '-C', at, '--no-optional-locks', ...args])
  const [status, counts, gitDir, base, untracked] = await Promise.all([
    git_('status', '--porcelain'),
    git_('rev-list', '--left-right', '--count', 'HEAD...origin/main'),
    git_('rev-parse', '--absolute-git-dir'),
    git_('merge-base', 'HEAD', 'origin/main'),
    git_('ls-files', '--others', '--exclude-standard'),
  ])
  const diff = base.stdout.trim() ? await git_('diff', '--name-only', base.stdout.trim()) : { stdout: '' }
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(n => Number.parseInt(n, 10) || 0)
  // an explicit stage (~/.claude/stage.sh build) wins until a PR exists
  const explicit = (await $.fs.read(`${gitDir.stdout.trim()}/claude-stage`).catch(() => ''))
    .trim().toLowerCase()
  const alias: Record<string, number> = { implementation: 3, impl: 3, verification: 4, exploration: 0 }
  const named = STAGES.findIndex(stage => stage.toLowerCase() === explicit)
  git = {
    dirty: status.stdout.split('\n').filter(Boolean).length,
    ahead,
    behind,
    stage: named >= 0 ? named : alias[explicit] ?? null,
    changed: [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))],
  }
}

// stage index and a short note, from the PR when there is one, else from git
function stageOf(pr: Pr | null): { index: number; note: string } {
  if (pr !== null) {
    if (pr.state === 'MERGED') {
      return { index: 7, note: '' }
    }
    if (pr.state === 'CLOSED') {
      return { index: 5, note: 'closed' }
    }
    if (pr.isDraft) {
      return { index: 5, note: 'draft' }
    }
    const note = pr.ci === 'pass' && pr.review === 'APPROVED'
      ? 'ready to merge'
      : pr.review === 'APPROVED' ? 'approved' : pr.review === 'CHANGES_REQUESTED' ? 'changes requested' : 'awaiting review'
    return { index: 6, note }
  }
  if (git.stage !== null) {
    return { index: git.stage, note: '' }
  }
  if (git.changed.length === 0) {
    return { index: 0, note: '' }
  }
  const isDocs = (file: string) => /\.(md|mdx|txt|rst)$|(^|\/)(docs?|plans?|specs?)\//.test(file)
  if (git.changed.every(isDocs)) {
    return { index: git.changed.some(file => /spec/i.test(file)) ? 2 : 1, note: '' }
  }

  return git.dirty > 0 ? { index: 3, note: '' } : { index: 4, note: 'no PR yet' }
}

// what you should do next, from facts first and the model's read second
function nextStep(pr: Pr | null): string {
  if (myState === 'waiting') {
    return 'answer Claude above'
  }
  if (pr?.state === 'OPEN') {
    if (pr.findings > 0) {
      return `/feature address — ${pr.findings} review finding(s)`
    }
    if (pr.ci === 'fail') {
      return `fix failing CI on #${pr.number}`
    }
    if (pr.ci === 'running') {
      return 'wait for CI'
    }
    if (pr.ci === 'pass' && pr.review === 'APPROVED') {
      return `merge #${pr.number}`
    }
  }
  if (pr?.state === 'MERGED') {
    return 'merged — grove clean --yes'
  }

  return summary.next || (myState === 'ready' ? 'give Claude its next instruction' : 'let it work')
}

async function palette($: EngineInterface): Promise<Palette> {
  type Theme = { palette?: string; palettes?: Record<string, Partial<Palette>> }
  const theme = await $.fs.read(`${hub}/theme.json`).then(parse<Theme>, () => undefined)
  return { ...CLAUDE, ...(theme?.palettes?.[theme.palette ?? 'claude'] ?? {}) }
}

function stateNote(now: number): string {
  if (myState === 'waiting') {
    return lastWaitMessage
  }
  if (myState === 'working') {
    const minutes = Math.floor((now - turnStartedAt) / 60_000)
    return minutes >= 1 ? `for ${minutes}m` : 'just started'
  }
  return myState === 'ready' ? 'finished its turn' : ''
}

// the header's facts as data, for the Grove app (it reads status/<name>.json)
async function publishDetails($: EngineInterface) {
  if (me === undefined) {
    return
  }
  const stage = stageOf(lastPr)
  const next = {
    stage: { index: stage.index, name: STAGES[stage.index], note: stage.note },
    git: { dirty: git.dirty, ahead: git.ahead, behind: git.behind },
    nextStep: nextStep(lastPr),
    note: stateNote(await $.clock.now()),
  }
  if (JSON.stringify(next) !== JSON.stringify(details)) {
    details = next
    await writeStatus($)
  }
}

async function paintHeader($: EngineInterface) {
  await publishDetails($)
  if (me === undefined || pane === undefined) {
    return
  }
  const esc = (text: string) => text.replace(/#/g, '##')
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  const pal = await palette($)
  const on = (fg: string, extra = '') => `#[bg=${pal.band} fg=${fg}${extra ? ` ${extra}` : ''}]`
  const pr = lastPr
  const stage = stageOf(pr)
  const fill = myState === 'offline' ? '#a8a8a8' : pal[myState]
  const note = stateNote(await $.clock.now())

  // row 1: NAME · ticket · state pill · note ············ NEXT ▸ next
  const row1 = [
    `#[bg=${pal.name} fg=#000000 bold] ${esc(me.name)} `,
    me.ticket ? `${on(TEXT_2, 'nobold')}  ${esc(me.ticket)} ` : `${on(TEXT_2, 'nobold')} `,
    `${on(TEXT_2)}  #[bg=${fill} fg=#000000 bold] ${ICON[myState]} ${STATE_WORD[myState]} `,
    note ? `${on(TEXT_2, 'nobold')}  ${esc(clip(note, 48))}` : on(TEXT_2, 'nobold'),
    `#[align=right]${on(pal.accent, 'bold')}NEXT ▸ ${on(TEXT, 'bold')}${esc(clip(nextStep(pr), 70))} `,
  ].join('')

  // row 2: recap ············ PR · CI · findings · git · ports
  const sep = `${on(RULE, 'nobold')}  ·  `
  const facts: string[] = []
  if (pr === null) {
    facts.push(`${on(TEXT_2)}no PR`)
  } else {
    facts.push(`${on(pal.name)}PR ##${pr.number}`)
    if (pr.state === 'OPEN') {
      const ci = { pass: [pal.ready, 'CI passing ✓'], fail: ['#ff8f8f', 'CI failing ✗'],
        running: ['#e6e6b8', 'CI running …'], none: [TEXT_2, 'no CI yet'] }[pr.ci]
      facts.push(`${on(ci[0] ?? TEXT_2)}${ci[1]}`)
    } else {
      facts.push(`${on(TEXT_2)}${pr.state.toLowerCase()}`)
    }
    if (pr.findings > 0) {
      facts.push(`${on(pal.accent)}${pr.findings} finding${pr.findings > 1 ? 's' : ''}`)
    }
  }
  const gitBits = [git.dirty > 0 ? `✎${git.dirty}` : '', git.ahead > 0 ? `↑${git.ahead}` : '', git.behind > 0 ? `↓${git.behind}` : '']
    .filter(Boolean).join(' ')
  if (gitBits) {
    facts.push(`${on(TEXT_2)}${gitBits}`)
  }
  const portList = Object.entries(portsOf(me)).map(([svc, port]) => `${svc} :${port}`).join('  ')
  if (portList) {
    facts.push(`${on(TEXT_2)}${portList}`)
  }
  const recap = summary.work
    ? `${on(TEXT)} ${esc(clip(summary.work, 60))}${summary.now ? `${on(TEXT_2)} — ${esc(clip(summary.now, 40))}` : ''}`
    : `${on(TEXT_2)} no recap yet — it appears after Claude's first turn`
  const row2 = `${recap}#[align=right]${facts.join(sep)} `

  // row 3: the stage track (current stage underlined, in words); panel buttons come from grove
  const track = STAGES.map((name, index) => {
    if (index === stage.index) {
      const label = index === 7 ? '✓ Merged' : `${name} ${index + 1}/8`
      return `${on(pal.accent, 'bold underscore')}${label}${on(TEXT_2, 'nobold nounderscore')}`
    }
    return `${on(index < stage.index ? TEXT_2 : RULE, 'nobold')}${name}`
  }).join(`${on(RULE)} ─ `)
  const row3 = ` ${track}${stage.note ? `${on(TEXT_2)}   ${esc(stage.note)}` : ''}`

  const header = [row1, row2, row3, fill].join('\n')
  if (header !== lastHeader) {
    lastHeader = header
    await run($, ['tmux',
      'set-option', '-w', '-t', pane, '@grove_h1', row1, ';',
      'set-option', '-w', '-t', pane, '@grove_h2', row2, ';',
      'set-option', '-w', '-t', pane, '@grove_h3', row3, ';',
      'set-option', '-w', '-t', pane, '@grove_fill', fill])
  }
}

// a 3-part reading of the conversation, by a small model, at most once a minute
async function summarize($: EngineInterface) {
  const now = await $.clock.now()
  if (me === undefined || now - lastSummaryAt < SUMMARY_GAP_MS) {
    return
  }
  lastSummaryAt = now
  const messages = await $.session.messages()
  const task = messages.find(m => m.role === 'user' && m.text.trim() !== '')
  if (task === undefined) {
    return
  }
  const tail = messages.slice(-14).map(m => {
    const tools = m.toolUses.map(t => t.tool).join(', ')
    return `${m.role}: ${m.text.slice(0, 400)}${tools ? ` [tools: ${tools}]` : ''}`
  })
  const reply = await $.model.complete({
    model: SUMMARY_MODEL,
    maxTokens: 200,
    system: 'You label a coding session for a status bar. Reply with JSON only: '
      + '{"work": "what the feature is, <= 8 words", "now": "where it stands, <= 6 words", '
      + '"next": "the next concrete step, <= 8 words"}. No trailing period.',
    prompt: `Feature: ${me.name}${me.ticket ? ` (${me.ticket})` : ''}\n\nTask: ${task.text.slice(0, 1200)}\n\nLatest:\n${tail.join('\n')}`,
  })
  if (!reply.isAnswered) {
    return
  }
  const json = reply.text.match(/\{[\s\S]*\}/)?.[0]
  const parsed = json ? parse<Partial<Summary>>(json) : undefined
  if (parsed === undefined) {
    return
  }
  summary = {
    work: String(parsed.work ?? summary.work).slice(0, 80),
    now: String(parsed.now ?? summary.now).slice(0, 60),
    next: String(parsed.next ?? summary.next).slice(0, 80),
  }
  await writeStatus($)
  await paintHeader($)
}

async function setState($: EngineInterface, state: FeatureState, message = '') {
  if (me === undefined || (state === myState && state !== 'waiting')) {
    return
  }
  myState = state
  await writeStatus($, message)
  if (pane !== undefined) {
    // a window flag the tmux status bar shows (see tmux.conf)
    const flag = NEEDS_YOU.includes(state) ? ICON[state] : ''
    await run($, ['tmux', 'set-option', '-w', '-t', pane, '@grove_attn', flag])
  }
  if (state === 'working') {
    // keep the Mac awake while any agent works; the watcher lets go once none do
    await run($, [cli, 'keepawake'])
  }
  if (state === 'ready') {
    // a turn ended: refresh the feature's recap (detached; grove spaces these out and skips if nothing changed)
    await run($, [cli, 'recap', me.name, '--bg'])
  }
  if (state === 'waiting') {
    // a desktop notification, unless you are looking at this window
    const seen = pane === undefined
      ? { stdout: '' }
      : await run($, ['tmux', 'display-message', '-p', '-t', pane, '#{window_active}#{session_attached}'])
    if (!seen.stdout.startsWith('11')) {
      await notify($, `Claude · ${me.name}`, message || 'needs your input')
    }
  }
  await paintHeader($)
  await refresh($)
}

// Inside a Grove pane $TMUX is set, and it beats TMUX_TMPDIR: a test that points TMUX_TMPDIR at a temp folder
// still drives the live server that hosts every agent, and its `kill-server` stops them all. A tmux call is
// isolated only with its own socket (`tmux -S path` / `-L name`), or with TMUX unset and TMUX_TMPDIR set.
function liveTmuxRisk(command: string): string | null {
  const calls = command.split(/[;&|\n]+/).filter(part => /(^|[\s(`$])tmux(\s|$)/.test(part))
  const shared = calls.filter(part => !/\btmux\s+(?:-\w+\s+\S+\s+)*-[SL]\s*\S/.test(part))
  if (shared.length === 0) {
    return null
  }
  const unset = /\bunset\s+(?:\w+\s+)*TMUX\b|\benv\s+(?:-\S+\s+)*-u\s*TMUX\b|(^|\s)TMUX=(\s|$)/.test(command)
  const tmpdir = /\bTMUX_TMPDIR=/.test(command)
  const how = 'give the test its own server: `tmux -S /tmp/x/sock …` on every call, or `unset TMUX` before setting TMUX_TMPDIR'
  if (tmpdir && !unset) {
    return `Blocked: $TMUX is set in this pane and overrides TMUX_TMPDIR, so these tmux commands would hit the live server that hosts every Grove agent. To test, ${how}.`
  }
  if (shared.some(part => /\bkill-server\b/.test(part)) && !(tmpdir && unset)) {
    return `Blocked: tmux kill-server here would stop the live server and every Grove agent and service in it. To test, ${how}.`
  }

  return null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    // GROVE_HUB / GROVE_BIN point a session at a throwaway hub (scripts/try-onboarding.sh)
    hub = (await $.env.get('GROVE_HUB')) || `${home}/.grove`
    cli = (await $.env.get('GROVE_BIN')) || `${hub}/bin/grove`
    const registry = await readRegistry($)
    const sid = await $.session.id()
    // a session row is its conversation, found by id; one without an id yet (Fix import) by its folder
    me = registry.find(one => one.kind === 'session' && one.session !== undefined
      ? one.session === sid
      : e.cwd === one.path || e.cwd.startsWith(`${one.path}/`))
    pane = await $.env.get('TMUX_PANE')
    if (me !== undefined) {
      const previous = await $.fs.read(`${me.dir}/status.json`).then(parse<Status>, () => undefined)
      summary = { work: previous?.work ?? '', now: previous?.now ?? '', next: previous?.next ?? '' }
      if (pane !== undefined) {
        await run($, ['tmux', 'set-option', '-w', '-t', pane, '@grove_feature', me.name])
      }
    }
    await update($, self, () => me?.name ?? null)

    await $.tool.register({
      name: 'new_feature',
      description: 'Start a related feature in its own git worktree, with its own branch, ports, dev servers and '
        + 'Claude session, handing over context from this conversation. Use it when the user asks to spin off, '
        + 'start or hand off a new or follow-up piece of work. The new session cannot see this conversation, so '
        + 'write `context` as a self-contained brief: what was learned here, the relevant files and functions, '
        + 'decisions already made, constraints, and what is out of scope.',
      inputSchema: {
        type: 'object',
        required: ['name', 'task', 'context'],
        properties: {
          name: { type: 'string', description: 'Short lowercase kebab-case name (e.g. csv-export), or a Linear ticket id like NUM-1234' },
          title: { type: 'string', description: 'Human title shown in the Grove sidebar (e.g. "CSV export for variance report")' },
          task: { type: 'string', description: 'What the new session should do, in one or two sentences' },
          context: { type: 'string', description: 'The handover brief: findings, files, decisions, constraints, out of scope' },
          base: { type: 'string', enum: ['main', 'current'], description: 'Branch from origin/main (default), or stack on this feature’s branch when the work depends on unmerged changes here' },
        },
      },
    })

    await $.command.register({
      name: 'feature',
      description: 'Grove: /feature [name] | new <name|TICKET> [-p prompt] | address | up|down|restart [name] | clean | doctor | done <name>',
    })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    if (me !== undefined) {
      await setState($, 'ready', 'session started')
      void summarize($).catch(() => undefined) // a resumed conversation has one to read
    }

    return next(e)
  })

  // tell the agent which feature, ports and tools it has
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (me === undefined) {
      return composed
    }
    const urls = Object.entries(portsOf(me)).map(([svc, port]) => `${svc} http://localhost:${port}`).join(', ')
    const text = [
      `# Grove`,
      `This session works on feature \`${me.name}\`${me.ticket ? ` (${me.ticket})` : ''}${me.project ? ` of project ${me.project}` : ''} in worktree ${me.path}, branch \`${me.branch}\`.`,
      ...(urls ? [
        `Its services run in panels beside you: ${urls}.`,
        `Use exactly these ports for curl and browser checks — never the project's defaults or another feature's ports.`,
      ] : []),
      ...(me.agentNotes ? [me.agentNotes] : []),
      `Manage services with \`${cli} restart|up|down ${me.name}\`; \`${cli} doctor\` diagnoses setup, ports and env.`,
    ].join('\n')

    return { sections: [...composed.sections, { id: 'grove:context', text, scope: 'session' }] }
  })

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now()
    await setState($, 'working')

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type !== 'idle_prompt') {
      lastWaitMessage = e.message.replace(/^Claude needs your /, '').replace(/^Claude /, '')
      await setState($, 'waiting', e.message).catch(() => undefined)
    }

    return next(e)
  })

  on('tool.call', { tool: /^mcp__grove__new_feature$/ }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
    const name = text('name')
    if (!name || !text('task')) {
      return { deny: 'new_feature needs a name and a task' }
    }
    const from = me ? `${me.name}${me.ticket ? ` (${me.ticket})` : ''}` : 'another session'
    const prompt = [
      text('task'),
      '',
      `## Context handed over from feature ${from}`,
      text('context') || '(none given)',
    ].join('\n')
    const argv = [cli, 'new', name]
    if (text('title')) {
      argv.push('--title', text('title'))
    }
    if (me) {
      argv.push('--parent', me.name)
    }
    if (text('base') === 'current' && me) {
      argv.push('--base', me.branch)
    }
    argv.push('-p', prompt)
    const made = await run($, argv)
    if (made.exitCode !== 0) {
      return { deny: (made.stderr || made.stdout).trim() || `grove new exited ${made.exitCode}` }
    }
    await refresh($)

    return { result: `${made.stdout.trim()}\nThe new feature's Claude session has started with the task and your handover. It shows in the Grove sidebar.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as unknown as { command?: unknown }).command
    const risk = typeof command === 'string' ? liveTmuxRisk(command) : null

    return risk ? { deny: risk } : next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (myState === 'waiting') {
      await setState($, 'working').catch(() => undefined) // the permission was answered
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      return done // a subagent finished; the main turn goes on
    }
    await setState($, 'ready', 'finished — your turn')
    void summarize($).catch(() => undefined)

    return done
  })

  on('session.end', async ($, e, next) => {
    // a /clear ends the conversation, not the session: it is still there, waiting for you
    await setState($, e.reason === 'clear' ? 'ready' : 'offline')

    return next(e)
  })

  on('command.run', { command: 'feature' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const here = me ? [me.name] : []

    if (verb === 'address') {
      const name = rest[0] ?? me?.name
      if (name === undefined) {
        return { text: 'Not in a feature worktree: /feature address <name>' }
      }
      const brief = await run($, [cli, 'findings', name, '--brief', '--mark'])
      if (brief.exitCode !== 0 || !brief.stdout.includes('For each one:')) {
        return { text: (brief.stdout + brief.stderr).trim() || 'No findings.' }
      }
      // submitting from the command itself would wait on this command's own turn
      $.clock.after(100, () => void $.prompt.submit({ text: brief.stdout }))

      return { text: 'Handing the review-bot findings to the agent.' }
    }

    // a prompt with spaces: /feature new NUM-123 -p fix the totals row
    const promptAt = rest.indexOf('-p')
    const argv = verb === ''
      ? [cli, 'ls']
      : verb === 'new' && promptAt >= 0
        ? [cli, 'new', ...rest.slice(0, promptAt), '-p', rest.slice(promptAt + 1).join(' ')]
        : VERBS.includes(verb)
          ? [cli, verb, ...(rest.length === 0 && ['restart', 'up', 'down', 'findings'].includes(verb) ? here : rest)]
          : [cli, 'go', verb]
    const result = await run($, argv)
    await refresh($)
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')

    return { text: text || (result.exitCode === 0 ? 'ok' : `grove exited ${result.exitCode}`) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, features)
    // inside tmux the window list and the pane header already say all this
    if (pane !== undefined || e.props.hasSurvey || rows.length === 0 || (await read($, isHidden))) {
      return next(e)
    }
    const mine = await read($, self)
    const { Box, Button, Text } = $.ui.resolve(e)
    const prLabel = (pr: Pr | null) => {
      if (pr === null) {
        return ''
      }
      if (pr.state !== 'OPEN') {
        return ` #${pr.number} ${pr.state.toLowerCase()}`
      }

      return ` #${pr.number}${CI_ICON[pr.ci]}${pr.findings > 0 ? ` 💬${pr.findings}` : ''}`
    }

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>features </Text>
        {rows.slice(0, 9).map((row, index) => (
          <Button
            key={`go-${row.name}`}
            plain
            hotkey={String(index + 1)}
            label={`${ICON[row.state]} ${row.name}${row.name === mine ? '*' : ''}${prLabel(row.pr)}  `}
            onPress={() => void run($, [cli, 'go', row.name])}
          />
        ))}
        <Button key="hide" plain label="hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
