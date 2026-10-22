import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const hub = window.hub
// a feature's services and ports; registries from before projects had fePort / bePort
const portsOf = (f) => f.ports || Object.fromEntries(Object.entries({ be: f.bePort, fe: f.fePort }).filter(([, v]) => v))
// where a session runs: the project's main checkout, a folder of it, or elsewhere (its own path)
const placeOf = (dir, repo) => dir === repo ? 'main checkout'
  : repo && dir.startsWith(repo + '/') ? dir.slice(repo.length + 1)
  : dir.replace(/^\/Users\/[^/]+/, '~')
const STAGES = ['Explore', 'Design', 'Spec', 'Build', 'Verify', 'PR', 'Review', 'Merged']
// a glyph and a word for every state: colour only reinforces
const STATE = {
  waiting: { glyph: '❗', word: 'Needs you' },
  ready: { glyph: '✓', word: 'Your turn' },
  working: { glyph: '⏳', word: 'Working' },
  offline: { glyph: '·', word: 'Offline' },
}
const CI = {
  pass: ['ready', 'CI passing ✓'],
  fail: ['#ff8f8f', 'CI failing ✗'],
  running: ['#e6e6b8', 'CI running …'],
  none: ['#bcbcbc', 'no CI yet'],
}

// ---------- terminals: one xterm per tmux session, kept alive across switches ----------
const terms = new Map() // key -> entry
const byId = new Map()
let nextId = 1
const PAGE = Math.random().toString(36).slice(2, 8)
hub.term.onData((id, chunk) => byId.get(id)?.term.write(chunk))
hub.term.onExit((id) => {
  const t = byId.get(id)
  if (!t) return
  t.started = false
  t.term.write('\r\n\x1b[2m[session ended — switch away and back to reattach]\x1b[0m\r\n')
})

// screenshots and dropped files reach an agent as paths typed at its prompt; Claude attaches images
let notify = () => {} // the app's toast, set once it mounts
const typedPath = (p) => p.replace(/([^\w@%+=:,./-])/g, '\\$1') // backslash-escaped, as Terminal and iTerm drop them
async function shotInto(t, mode, image) {
  const r = await hub.shot(t.key.split(':')[0], mode, image && new Uint8Array(await image.arrayBuffer()), image?.type)
  if (r.error) return notify(r.error, r.error !== 'screenshot cancelled')
  t.term.paste(typedPath(r.path) + ' ')
  t.term.focus()
}
// the page must not navigate to a file dropped outside a terminal
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault())

function termFor(key, session) {
  let t = terms.get(key)
  if (t && t.session !== session) {
    hub.term.close(t.id)
    t.term.dispose()
    terms.delete(key)
    byId.delete(t.id)
    t = null
  }
  if (!t) {
    const el = document.createElement('div')
    el.className = 'xterm-host'
    const term = new Terminal({
      fontFamily: '"MesloLGS NF", "JetBrains Mono", "SF Mono", Menlo, monospace', // your iTerm font: its Nerd Font icons draw the shell prompt
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionClickForcesSelection: true,
      allowProposedApi: true,
      theme: { background: '#1c1c1c', foreground: '#eeeeee', cursor: '#eeeeee', selectionBackground: '#d7775766' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => hub.open(uri)))
    const id = `${PAGE}-${nextId++}` // unique across page reloads
    t = { key, session, term, fit, el, id, opened: false, started: false }
    term.onData((data) => hub.term.write(id, data))
    term.onResize(({ cols, rows }) => t.started && hub.term.resize(id, cols, rows))
    // app shortcuts (⌘…) belong to the app, not the terminal
    term.attachCustomKeyEventHandler((ev) => !(ev.metaKey && !['c', 'v', 'a'].includes(ev.key)))
    // ⌘V of a bare image (a ⌃⇧⌘4 screenshot, an image copied in a browser) goes in as a saved file;
    // xterm's own paste would send nothing. Caught before xterm's textarea sees it
    el.addEventListener('paste', (ev) => {
      const data = ev.clipboardData
      const image = [...(data?.files || [])].find((file) => file.type.startsWith('image/'))
      if (!image || data.getData('text/plain')) return
      ev.preventDefault()
      ev.stopPropagation()
      shotInto(t, 'image', image)
    }, true)
    el.addEventListener('drop', (ev) => {
      const paths = [...(ev.dataTransfer?.files || [])].map((file) => hub.pathOf(file)).filter(Boolean)
      if (!paths.length) return
      t.term.paste(paths.map(typedPath).join(' ') + ' ')
      t.term.focus()
    })
    terms.set(key, t)
    byId.set(id, t)
  }
  return t
}

function TerminalView({ termKey, session, focus }) {
  const host = useRef(null)
  useEffect(() => {
    const t = termFor(termKey, session)
    host.current.appendChild(t.el)
    if (!t.opened) {
      t.term.open(t.el)
      t.opened = true
    }
    const refit = () => {
      if (!host.current || host.current.offsetWidth === 0) return
      try {
        t.fit.fit()
      } catch {}
      if (!t.started) {
        t.started = true
        hub.term.open({ id: t.id, session, cols: t.term.cols, rows: t.term.rows })
      }
    }
    const ro = new ResizeObserver(refit)
    ro.observe(host.current)
    refit()
    return () => {
      ro.disconnect()
      t.el.remove()
    }
  }, [termKey, session])
  useEffect(() => {
    if (focus) setTimeout(() => terms.get(termKey)?.term.focus(), 30)
  }, [focus, termKey])
  return <div className="term" ref={host} />
}

// ---------- sidebar ----------
function Sidebar({ project, repo, elsewhere, features, current, onPick, onMenu, renaming, setRenaming, onRename, newOpen, setNewOpen, seed, onCreate, creating, closing = {}, filterRef, waitingOutside, onReview, failedCount, onFix, onKeys }) {
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  const [newName, setNewName] = useState('')
  const [task, setTask] = useState('')
  useEffect(() => {
    const f = features.find((x) => x.name === renaming)
    if (f) setDraft(f.title)
  }, [renaming])
  useEffect(() => {
    if (newOpen && seed) {
      setTask(seed)
      setNewName(seed.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 4).join('-').slice(0, 40))
    }
  }, [newOpen, seed])
  const q = filter.trim().toLowerCase()
  const shown = features.filter((f) => !q || f.title.toLowerCase().includes(q) || f.name.includes(q) || (f.ticket || '').toLowerCase().includes(q))
  const create = () => {
    if (!newName.trim()) return
    onCreate(newName.trim(), task.trim())
    setNewName('')
    setTask('')
    setNewOpen(false)
  }
  return (
    <nav className="side" aria-label={`Features of ${project || 'no project'}`}>
      <div className="project">
        <div className="pname" title={repo}>
          <b>{project || 'No project'}</b>
          <span>{repo.replace(/^\/Users\/[^/]+/, '~') || 'add a project to begin'}</span>
        </div>
        <button className="swap" type="button" title="Open another project (⌘⇧1…9) or add one (⌘⇧O)"
          aria-label={`Switch project${elsewhere ? `, ${elsewhere} feature${elsewhere > 1 ? 's' : ''} need you in other projects` : ''}`}
          onClick={() => hub.projectMenu(project)}>
          ⇄{elsewhere > 0 && <span className="elsewhere">❗{elsewhere}</span>}
        </button>
      </div>
      <div className="side-top">
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input ref={filterRef} placeholder="Search features  ⌘K" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search features" />
        </label>
        <button className="iconbtn" type="button" title="New feature (⌘N)" aria-label="New feature" onClick={() => setNewOpen(!newOpen)}>+</button>
      </div>

      {newOpen && (
        <form className="newcard" onSubmit={(e) => { e.preventDefault(); create() }} onKeyDown={(e) => e.key === 'Escape' && setNewOpen(false)}>
          <label htmlFor="newname">New feature</label>
          <input id="newname" autoFocus placeholder="name or TICKET-123" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <textarea aria-label="Task for Claude (optional)" placeholder="task for Claude (optional) · ⌘↩ creates" rows={task.includes('\n') ? 4 : 2} value={task}
            onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); create() } }} />
          <div className="actions">
            <button className="btn primary" type="submit" disabled={!newName.trim()}>Create</button>
            <button className="btn" type="button" onClick={() => setNewOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <ul className="list">
        {creating && (
          <li><div className="row"><span className="glyph">⏳</span><span className="text"><div className="title busy">Creating {creating}…</div><div className="sub">worktree · ports · servers</div></span></div></li>
        )}
        {[...shown.filter((x) => x.kind !== 'session'), ...shown.filter((x) => x.kind === 'session')].map((f, i, all) => {
          const heading = f.kind === 'session' && (i === 0 || all[i - 1].kind !== 'session')
          const st = f.status.state || 'offline'
          const shutting = closing[f.name]
          const pr = f.pr
          const prBit = pr ? ` · #${pr.number}${pr.state === 'OPEN' ? ({ pass: ' ✓', fail: ' ✗', running: ' ⟳', none: '' })[pr.ci] : pr.state === 'MERGED' ? ' merged' : ''}` : ''
          if (renaming === f.name) {
            return (
              <li key={f.name} className="row-edit">
                <input autoFocus aria-label={`Rename ${f.name}: enter saves, escape cancels`} value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onRename(f.name, draft)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => setRenaming(null)} />
              </li>
            )
          }
          const where = f.helper === 'import' ? '◷ bringing in what failed'
            : f.helper === 'setup' ? '◷ setting up the project'
            : f.kind === 'session'
            ? `◷ ${placeOf(f.path, repo)} · ⎇ ${f.branch || '?'}`
            : null
          return (
            <li key={f.name}>
              {heading && <div className="group" role="presentation">Sessions</div>}
              <button type="button" className={`row ${f.name === current ? 'current' : ''} ${st}${shutting ? ' closing' : ''}`} aria-current={f.name === current ? 'page' : undefined}
                aria-busy={shutting ? true : undefined}
                title={shutting ? `${f.title} — ${shutting.word}` : `${f.title} — ${STATE[st].word}${f.status.message ? `: ${f.status.message}` : ''}`}
                onClick={() => onPick(f.name)} onDoubleClick={() => !shutting && setRenaming(f.name)}
                onContextMenu={(e) => { e.preventDefault(); if (!shutting) onMenu(f) }}>
                {shutting
                  ? <span className="glyph"><span className="spinner" aria-label={shutting.word} /></span>
                  : <span className="glyph" style={{ color: `var(--${st === 'offline' ? 'text-3' : st})` }} aria-label={STATE[st].word}>{STATE[st].glyph}</span>}
                <span className="text">
                  <div className="title">{f.title}</div>
                  <div className="sub">{shutting ? `${shutting.word.toLowerCase()}…` : <>{st === 'offline' && 'offline · '}{where || `${f.parent ? `↳ ${f.parent} · ` : ''}⎇ ${f.branch.replace(/^[^/]+\//, '')}${prBit}`}</>}</div>
                </span>
                {i < 9 && <span className="num" aria-hidden="true">⌘{i + 1}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {failedCount > 0 && (() => {
        // once a Fix import session exists, the note leads to it instead of starting another
        const fixer = features.find((x) => x.helper === 'import')
        return (
          <button type="button" className="nudge failed" onClick={() => (fixer ? onPick(fixer.name) : onFix())}
            title={fixer ? 'Open the Fix import session' : 'What could not be brought in, and a Claude session briefed to fix it'}>
            <span aria-hidden="true">⚠</span> {failedCount} couldn't come in <b>{fixer ? 'Claude is on it' : 'Fix with Claude'}</b>
          </button>
        )
      })()}
      {waitingOutside > 0 && (
        <button type="button" className="nudge" onClick={onReview} title="Worktrees and Claude conversations of this repo that Grove is not running yet (⌘⇧I)">
          <span aria-hidden="true">↧</span> {waitingOutside} in progress outside Grove <b>Review</b>
        </button>
      )}
      <button className="side-foot" type="button" onClick={onKeys} title="All keyboard shortcuts (⌘/)">⌘N new · <b>⌘/ all shortcuts</b></button>
    </nav>
  )
}

// covers the work area while grove done runs, so the click visibly did something
function ClosingCover({ f, job }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.round((now - job.since) / 1000))
  return (
    <div className="closing-cover" role="status" aria-live="polite">
      <span className="spinner big" aria-hidden="true" />
      <h1>{job.word} {f.title}…</h1>
      <p>{job.detail}</p>
      <p className="busy">{secs}s</p>
    </div>
  )
}

// ---------- header (design A) ----------
function Header({ f, pal, panels, openList, onToggle, onFix, fixing, repo }) {
  const st = f.status.state || 'offline'
  const d = f.status.details || {}
  const fill = st === 'offline' ? '#a8a8a8' : pal[st]
  const note = d.note || f.status.message || ''
  const next = d.nextStep || f.status.next || 'give Claude its next instruction'
  const stage = d.stage?.index ?? 0
  const git = d.git || {}
  const pr = f.pr
  const ci = pr && pr.state === 'OPEN' ? CI[pr.ci] || CI.none : null
  const gitBits = [git.dirty ? `✎${git.dirty}` : '', git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : ''].filter(Boolean).join(' ')
  return (
    <header className="header" style={{ '--fill': fill }}>
      <div className="hrow">
        <span className="name" title={f.name}>{f.title}</span>
        {f.ticket && <span className="ticket">{f.ticket}</span>}
        {f.parent && <span className="ticket" title={`Spun off from ${f.parent}`}>↳ from {f.parent}</span>}
        <span className="pill" style={{ background: fill }}>{STATE[st].glyph} {STATE[st].word}</span>
        {note && <span className="note">{note}</span>}
        <span className="grow" />
        {st === 'offline'
          ? <button className="btn primary fix" type="button" disabled={fixing} title="Start what stopped: panels, Claude, dead services (⌘⇧F)" onClick={onFix}>
              {fixing ? 'Fixing…' : 'Fix'}<kbd>⌘⇧F</kbd>
            </button>
          : <span className="next"><b>NEXT ▸</b>{next}</span>}
      </div>
      <div className="hrow">
        <span className="recap">
          {f.status.work || f.recap?.goal || <span>No recap yet — it appears after Claude’s first turn</span>}
          {f.status.work && f.status.now && <span> — {f.status.now}</span>}
        </span>
        <span className="grow" />
        <span className="facts">
          {f.helper === 'import' ? <span>helper · brings in what could not come in</span> : f.helper === 'setup' ? <span>helper · writes this project's Grove config</span> : f.kind === 'session' ? <span>{placeOf(f.path, repo)} · ⎇ {f.branch}</span> : pr ? <a role="link" tabIndex={0} onClick={() => hub.open(pr.url)} onKeyDown={(e) => e.key === 'Enter' && hub.open(pr.url)}>PR #{pr.number}</a> : <span>no PR</span>}
          {ci && <span style={{ color: ci[0] === 'ready' ? pal.ready : ci[0] }}>{ci[1]}</span>}
          {pr && pr.state !== 'OPEN' && <span>{pr.state.toLowerCase()}</span>}
          {pr?.findings > 0 && <span style={{ color: pal.accent }}>{pr.findings} finding{pr.findings > 1 ? 's' : ''}</span>}
          {gitBits && <span>{gitBits}</span>}
          {Object.entries(portsOf(f)).map(([svc, port]) => f.links?.[svc]
            ? <a key={svc} role="link" tabIndex={0} title={`Open ${f.links[svc]}`} onClick={() => hub.open(f.links[svc])} onKeyDown={(e) => e.key === 'Enter' && hub.open(f.links[svc])}>{svc} :{port}</a>
            : <span key={svc}>{svc} :{port}</span>)}
        </span>
      </div>
      <div className="hrow">
        {f.kind !== 'session' && <span className="track" aria-label={`Stage ${stage + 1} of 8: ${STAGES[stage]}`}>
          {STAGES.map((s, i) => (
            <span key={s}>
              {i > 0 && <span className="sep">─</span>}
              <span className={i === stage ? 'cur' : i < stage ? 'done' : ''}>{i === stage ? `${s} ${i + 1}/8` : s}</span>
            </span>
          ))}
          {d.stage?.note && <span className="done">   {d.stage.note}</span>}
        </span>}
        <span className="grow" />
        <span className="toggles">
          {panels.map((p) => {
            const on = openList.includes(p.name)
            return (
              <button key={p.name} type="button" className="toggle" aria-pressed={on} title={`${on ? 'Close' : 'Open'} ${p.name}${p.key ? ` (⌘⌥${p.key.toUpperCase()})` : ''}`} onClick={() => onToggle(p.name)}>
                {on ? '■' : '□'} {p.name}{p.key && <kbd>⌘⌥{p.key.toUpperCase()}</kbd>}
              </button>
            )
          })}
        </span>
      </div>
    </header>
  )
}

// ---------- main panel tabs: Claude, and what you keep about the feature ----------
const TABS = [
  { id: 'claude', label: 'Claude' },
  { id: 'summary', label: 'Summary' },
  { id: 'usage', label: 'Usage' },
]

function TabBar({ tab, onTab, stats }) {
  const refs = useRef({})
  const move = (e) => {
    const i = TABS.findIndex((t) => t.id === tab)
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    const next = TABS[(to + TABS.length) % TABS.length].id
    onTab(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="tabs" role="tablist" aria-label="Main panel" onKeyDown={move}>
      {TABS.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[t.id] = el }} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`tabpanel-${t.id}`}
          aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className="tab" title={`${t.label} (⌃${i + 1})`} onClick={() => onTab(t.id)}>
          {t.label}<kbd>⌃{i + 1}</kbd>
        </button>
      ))}
      <span className="grow" />
      <UsageChip stats={stats} onOpen={() => onTab('usage')} />
    </div>
  )
}

// a hub document (notes, retro) for one feature: loads on switch, saves a beat after typing stops
function useDoc(kind, name, version = 0) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('loading')
  const pending = useRef(null)
  useEffect(() => {
    let live = true
    setSaved('loading')
    hub.doc.read(kind, name).then((t) => {
      if (!live) return
      setText(t)
      setSaved('saved')
    })
    return () => {
      live = false
      if (pending.current) {
        clearTimeout(pending.current.timer)
        hub.doc.write(kind, name, pending.current.text)
        pending.current = null
      }
    }
  }, [kind, name, version])
  const edit = (t) => {
    setText(t)
    setSaved('unsaved')
    if (pending.current) clearTimeout(pending.current.timer)
    const timer = setTimeout(async () => {
      pending.current = null
      setSaved((await hub.doc.write(kind, name, t)) ? 'saved' : 'error')
    }, 600)
    pending.current = { timer, text: t }
  }
  return [text, edit, saved]
}

const SAVED = { loading: 'Loading…', unsaved: 'Editing…', saved: 'Saved', error: 'Could not save' }

function SaveState({ saved, file }) {
  return <span className={`saved ${saved}`} role="status" title={file}>{SAVED[saved]}</span>
}

const docPath = (f, file) => `~/.grove/projects/${f.project}/${f.name}/${file}`

// the scratchpad: your notes on the feature, a place to draft things for Claude
function Scratchpad({ f, doc }) {
  const [text, edit, saved] = doc
  return (
    <section className="scratch" aria-label="Scratchpad">
      <div className="doc-bar">
        <h2>Scratchpad</h2>
        <span className="grow" />
        <SaveState saved={saved} file={docPath(f, 'notes.md')} />
      </div>
      <textarea className="doc-text scratch-text" spellCheck value={text} disabled={saved === 'loading'} aria-label="Scratchpad notes"
        placeholder="Ideas, follow-ups, things to tell Claude. Select any text on this page and right-click: Send to agent (⌘↩) or New feature (⇧⌘↩)."
        onChange={(e) => edit(e.target.value)} />
    </section>
  )
}

// the text selected anywhere inside root: in a text box (the one clicked, else the focused one), or on the page
function selectionIn(root, target) {
  if (!root) return ''
  const el = target?.tagName === 'TEXTAREA' ? target : document.activeElement
  if (el && el.tagName === 'TEXTAREA' && root.contains(el)) return el.value.slice(el.selectionStart, el.selectionEnd).trim()
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) return ''
  return sel.toString().trim()
}

// a retro is markdown with one ## section per question, so it reads well outside Grove too
const RETRO = [
  { heading: 'What went well', hint: 'what worked: approach, tools, prompts worth repeating' },
  { heading: 'What didn’t', hint: 'what slowed you or Claude down, what went wrong' },
  { heading: 'What to try next time', hint: 'one or two changes to make on the next feature' },
]

function parseRetro(text) {
  const sections = {}
  let head = ''
  for (const line of text.split('\n')) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      head = m[1]
      sections[head] = []
    } else {
      ;(sections[head] ||= []).push(line)
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([h, lines]) => [h, lines.join('\n').trim()]))
}

function writeRetro(title, sections) {
  const known = RETRO.map((q) => q.heading)
  const extra = Object.keys(sections).filter((h) => h && !known.includes(h)) // sections added by hand stay
  return [`# Retro: ${title}`, ...[...known, ...extra].map((h) => `## ${h}\n\n${sections[h] || ''}`)].join('\n\n').trimEnd() + '\n'
}

const RETRO_LOOK = { 'What went well': '✓', 'What didn’t': '✗', 'What to try next time': '→' }

// the retro: drafted once as the feature wraps up (grove retro), lessons for the next feature with an agent
function RetroSection({ f, say }) {
  const [version, setVersion] = useState(0)
  const [text, edit, saved] = useDoc('retro', f.name, version)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const sections = useMemo(() => parseRetro(text), [text])
  useEffect(() => setEditing(false), [f.name])
  const draft = async () => {
    if (text.trim() && !(await hub.confirm('Draft the retro again?', 'The current one is kept as retro.prev.md beside it.', 'Draft again'))) return
    setBusy(true)
    const r = await hub.grove(['retro', f.name])
    setBusy(false)
    if (r.code) return say((r.stderr || r.stdout).trim().replace(/^grove: /, ''), true)
    setVersion((v) => v + 1)
  }
  const bullets = (h) => (sections[h] || '').split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
  return (
    <section className="retro" aria-label="Retro">
      <div className="doc-bar">
        <h2>Retro</h2>
        <span className="grow" />
        {text.trim() && <SaveState saved={saved} file={docPath(f, 'retro.md')} />}
        {text.trim() && <button className="btn" type="button" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button>}
        <button className="btn" type="button" disabled={busy} onClick={draft}>{busy ? 'Drafting…' : text.trim() ? '↻ Draft again' : '✎ Draft retro'}</button>
      </div>
      {editing ? (
        <textarea className="doc-text retro-text" spellCheck value={text} aria-label="Retro (markdown)" onChange={(e) => edit(e.target.value)} />
      ) : text.trim() ? (
        <div className="recap-grid">
          {RETRO.map((q) => (
            <RecapList key={q.heading} glyph={RETRO_LOOK[q.heading] || '•'} word={q.heading} items={bullets(q.heading)} empty="—" />
          ))}
        </div>
      ) : (
        <p className="busy">{busy ? 'Reading the conversations, recap and git…' : 'Draft it as the feature wraps up: what went well, what didn’t, and what to do differently with an agent next time.'}</p>
      )}
    </section>
  )
}

// the task section of a brief (everything else in it is Grove's standing instructions)
const taskOf = (brief) => {
  const m = /^# Task\s*\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/m.exec(brief)
  return (m ? m[1] : brief).trim()
}

const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

// one recap section: an icon and a word (never colour alone), then fragments to scan
function RecapList({ glyph, word, items, colour, empty }) {
  if (!items.length && !empty) return null
  return (
    <div className="recap-block">
      <h3 style={colour ? { color: colour } : undefined}><span aria-hidden="true">{glyph}</span> {word}</h3>
      {items.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="recap-none">{empty}</p>}
    </div>
  )
}

// a recap from before the summary had a task list still reads as one
const asList = (v) => (Array.isArray(v) ? v : [])
function tasksOf(r) {
  if (Array.isArray(r.tasks) && r.tasks.length) return r.tasks
  return [...asList(r.done).map((text) => ({ text, state: 'done' })), ...(r.now ? [{ text: r.now, state: 'doing' }] : []),
    ...asList(r.next).map((text) => ({ text, state: 'todo' }))]
}
const decisionsOf = (r) => asList(r.decisions).map((d) => (typeof d === 'string' ? { choice: d, why: '' } : d)).filter((d) => d?.choice)
const TASK_LOOK = { done: { glyph: '✓', word: 'done' }, doing: { glyph: '▸', word: 'now' }, todo: { glyph: '○', word: 'to do' } }
const CHECK_LOOK = { pass: { glyph: '✓', word: 'passed' }, fail: { glyph: '✗', word: 'failed' }, todo: { glyph: '○', word: 'not run yet' } }
const RISK_LOOK = { reach: 'Reaches', assumption: 'If an assumption is wrong', rollout: 'Rollout' }
const risksOf = (r) => asList(r.risks).map((x) => (typeof x === 'string' ? { kind: 'reach', text: x } : x)).filter((x) => x?.text)

// one of the summary's four questions: a numbered heading, then what answers it
function RecapSection({ n, title, children }) {
  return (
    <div className="recap-block recap-section" role="group" aria-label={title}>
      <h3 className="recap-q"><span className="recap-n" aria-hidden="true">{n}</span> {title}</h3>
      {children}
    </div>
  )
}

// the diagram from the recap, laid out in columns: each node one step right of everything that points at it
const NODE_W = 156, NODE_H = 40, ROW_GAP = 16, PAD = 8
function layout({ nodes, edges }) {
  // edges that close a cycle (found depth first, in the model's node order) do not move columns:
  // they are drawn back underneath instead
  const out = Object.fromEntries(nodes.map((n) => [n.id, []]))
  edges.forEach((e) => out[e.from].push(e))
  const seen = {}, forward = []
  const visit = (id) => {
    seen[id] = 'open'
    for (const e of out[id]) {
      if (seen[e.to] === 'open') continue
      forward.push(e)
      if (!seen[e.to]) visit(e.to)
    }
    seen[id] = 'shut'
  }
  nodes.forEach((n) => seen[n.id] || visit(n.id))
  const layer = Object.fromEntries(nodes.map((n) => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) { // longest path over what is now acyclic
    let moved = false
    for (const e of forward) {
      if (layer[e.to] < layer[e.from] + 1) {
        layer[e.to] = layer[e.from] + 1
        moved = true
      }
    }
    if (!moved) break
  }
  const cols = []
  for (const n of nodes) (cols[layer[n.id]] ||= []).push(n)
  const packed = cols.filter(Boolean)
  const colOf = Object.fromEntries(packed.flatMap((col, ci) => col.map((n) => [n.id, ci])))
  // wide enough for the longest edge label (about 6.5px a character at 11px), never under 64
  const gap = Math.max(64, ...edges.map((e) => (e.label || '').length * 6.5 + 20))
  const back = edges.some((e) => colOf[e.to] <= colOf[e.from])
  const tallest = Math.max(...packed.map((c) => c.length))
  const height = tallest * NODE_H + (tallest - 1) * ROW_GAP
  const at = {}
  packed.forEach((col, ci) => {
    const top = (height - (col.length * NODE_H + (col.length - 1) * ROW_GAP)) / 2
    col.forEach((n, ri) => { at[n.id] = { x: PAD + ci * (NODE_W + gap), y: PAD + top + ri * (NODE_H + ROW_GAP), col: ci } })
  })
  // room above for edge labels, and below for edges that go back
  return { at, gap, width: PAD * 2 + packed.length * NODE_W + (packed.length - 1) * gap, height: PAD * 2 + height + (back ? NODE_H : 0) }
}
// a label in at most two lines of about 20 characters
function wrap(label, width = 20) {
  const words = label.split(' ')
  const lines = ['']
  for (const w of words) {
    const line = lines[lines.length - 1]
    if (line && (line + ' ' + w).length > width && lines.length < 2) lines.push(w)
    else lines[lines.length - 1] = line ? `${line} ${w}` : w
  }
  return lines.map((l) => (l.length > width + 6 ? l.slice(0, width + 5) + '…' : l))
}

function Diagram({ diagram, pal }) {
  const { at, gap, width, height } = useMemo(() => layout(diagram), [diagram])
  const name = Object.fromEntries(diagram.nodes.map((n) => [n.id, n.label]))
  const said = diagram.edges.map((e) => `${name[e.from]} ${e.label || 'to'} ${name[e.to]}`).join('; ')
  return (
    <div className="diagram">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} role="img" aria-label={`Diagram: ${said || diagram.nodes.map((n) => n.label).join(', ')}`}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--text-3)" />
          </marker>
        </defs>
        {diagram.edges.map((e, i) => {
          const a = at[e.from], b = at[e.to]
          const forward = b.col > a.col
          let d, lx, ly
          if (forward) {
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x - 2, y2 = b.y + NODE_H / 2
            d = `M${x1} ${y1} C${x1 + gap / 2} ${y1} ${x2 - gap / 2} ${y2} ${x2} ${y2}`
            lx = (x1 + x2) / 2
            ly = (y1 + y2) / 2
          } else { // back to an earlier column (or the same one): round underneath
            const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y + NODE_H + 2
            const low = Math.max(y1, y2) + NODE_H * 0.8
            d = `M${x1} ${y1} C${x1} ${low} ${x2} ${low} ${x2} ${y2}`
            lx = (x1 + x2) / 2
            ly = low - 6
          }
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="var(--text-3)" strokeWidth="1.3" markerEnd="url(#arrow)" />
              {e.label && <text x={lx} y={ly - 4} textAnchor="middle" className="diagram-edge">{e.label}</text>}
            </g>
          )
        })}
        {diagram.nodes.map((n) => {
          const p = at[n.id]
          const lines = wrap(n.label)
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx="7" fill="#242424" stroke={pal.accent} strokeWidth="1.2" />
              {lines.map((l, i) => (
                <text key={i} x={p.x + NODE_W / 2} y={p.y + NODE_H / 2 + (i - (lines.length - 1) / 2) * 14 + 4} textAnchor="middle" className="diagram-node">{l}</text>
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// a screenshot kept with grove proof: loaded once it is on screen, opened in Preview on click
function ProofShot({ f, shot }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let live = true
    hub.proof.image(f.name, shot.file).then((s) => live && setSrc(s))
    return () => { live = false }
  }, [f.name, shot.file])
  const when = shot.at ? new Date(shot.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  return (
    <li>
      <button type="button" className="proof-shot" onClick={() => hub.proof.open(f.name, shot.file)} title={`Open ${shot.file} in Preview`}>
        {src ? <img src={src} alt={shot.caption || shot.file} /> : <span className="proof-wait">loading…</span>}
      </button>
      <span className="proof-caption">{shot.caption || shot.file}{when && <span className="dim"> · {when}</span>}</span>
    </li>
  )
}

// the feature at a glance, written by `grove recap` after Claude's turns (or now, with Refresh)
function Recap({ f, pal }) {
  const r = f.recap
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000) // keeps "n min ago" honest
    return () => clearInterval(t)
  }, [])
  useEffect(() => setError(''), [f.name])
  const refresh = async () => {
    setBusy(true)
    setError('')
    const res = await hub.grove(['recap', f.name, '--force'])
    setBusy(false)
    if (res.code) setError((res.stderr || res.stdout).trim().replace(/^grove: /, ''))
  }
  // the same Markdown as `grove recap <name> --markdown`, ready for a PR description
  const [copied, setCopied] = useState('')
  const copy = async () => {
    const res = await hub.grove(['recap', f.name, '--markdown'])
    if (res.code) return setError((res.stderr || res.stdout).trim().replace(/^grove: /, ''))
    try {
      await navigator.clipboard.writeText(res.stdout)
      setCopied('Copied')
    } catch {
      setCopied('Copy failed')
    }
    setTimeout(() => setCopied(''), 2500)
  }
  const tasks = r ? tasksOf(r) : []
  const done = tasks.filter((t) => t.state === 'done').length
  const decisions = r ? decisionsOf(r) : []
  const checks = asList(r?.validation)
  const unverified = asList(r?.unverified)
  const risks = r ? risksOf(r) : []
  const focus = asList(r?.focus)
  const shots = asList(f.proof).slice(-6).reverse()
  const checkColour = { pass: pal.ready, fail: '#ff9b9b', todo: 'var(--text-3)' }
  // a recap written before the review sections has none of their keys: say so rather than "none"
  const older = r && !('risks' in r)
  return (
    <section className="recap" aria-label="Summary">
      <div className="recap-head">
        <div className="recap-title">
          <h2 className="recap-goal">{r?.summary || r?.goal || 'No summary yet'}</h2>
          {r?.summary && r.goal && <span className="recap-sub">{r.goal}</span>}
        </div>
        {r?.updatedAt && <span className="recap-age">updated {ago(r.updatedAt)}</span>}
        {r && <button className="btn" onClick={copy} aria-label="Copy the summary as a pull request description in Markdown">{copied ? `⧉ ${copied}` : '⧉ Copy as PR description'}</button>}
        <button className="btn" onClick={refresh} disabled={busy} aria-label="Refresh the summary">{busy ? '↻ Refreshing…' : '↻ Refresh'}</button>
      </div>
      {error && <p className="recap-error" role="alert">Could not refresh: {error}</p>}
      {copied && <span className="sr-only" role="status">{copied}</span>}
      {!r && <p className="busy">{busy ? 'Reading the conversation and git…' : 'Written after Claude’s next turn, or now with Refresh.'}</p>}
      {older && <p className="recap-none">This summary predates the approach and review sections — Refresh to add them.</p>}
      {r && (
        <>
          <RecapSection n="1" title="Why">
            {asList(r.why).length ? <ul>{asList(r.why).map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="recap-none">not recorded yet</p>}
            {r.change?.before && (
              <dl className="recap-change">
                <dt>Before</dt><dd>{r.change.before}</dd>
                <dt>After</dt><dd>{r.change.after}</dd>
              </dl>
            )}
          </RecapSection>
          <RecapSection n="2" title="Approach">
            {r.approach && <p className="recap-prose">{r.approach}</p>}
            {r.diagram?.nodes?.length > 1 && <Diagram diagram={r.diagram} pal={pal} />}
            {r.example && <p className="recap-prose"><span className="recap-label">Example</span> {r.example}</p>}
            {decisions.length > 0 && (
              <div className="recap-block">
                <h4><span aria-hidden="true">◆</span> Key decisions</h4>
                <ul>{decisions.map((d, i) => <li key={i}><b>{d.choice}</b>{d.why && <span className="dim"> — {d.why}</span>}</li>)}</ul>
              </div>
            )}
            {!r.approach && !decisions.length && !(r.diagram?.nodes?.length > 1) && <p className="recap-none">not recorded yet</p>}
          </RecapSection>
          <RecapSection n="3" title="How we know it works">
            {checks.length > 0 && (
              <ul className="tasks">
                {checks.map((c, i) => {
                  const look = CHECK_LOOK[c.result] || CHECK_LOOK.todo
                  return (
                    <li key={i}>
                      <span className="task-glyph" aria-hidden="true" style={{ color: checkColour[c.result] || checkColour.todo }}>{look.glyph}</span>
                      <span>{c.check} <span className="check-word" style={{ color: checkColour[c.result] || checkColour.todo }}>{look.word}</span></span>
                    </li>
                  )
                })}
              </ul>
            )}
            {unverified.length > 0 && (
              <div className="recap-block">
                <h4 style={{ color: pal.waiting }}><span aria-hidden="true">○</span> Not verified</h4>
                <ul>{unverified.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
            {shots.length > 0 && <ul className="proof">{shots.map((s) => <ProofShot key={s.file} f={f} shot={s} />)}</ul>}
            {!checks.length && !shots.length && <p className="recap-none">nothing checked yet — screenshots kept with <code>grove proof {f.name} &lt;image&gt; &lt;what it shows&gt;</code> appear here</p>}
          </RecapSection>
          <RecapSection n="4" title="Risks and reviewer focus">
            {risks.length > 0 && (
              <ul className="recap-risks">
                {risks.map((x, i) => <li key={i}><b>{RISK_LOOK[x.kind] || RISK_LOOK.reach}:</b> {x.text}</li>)}
              </ul>
            )}
            {focus.length > 0 && (
              <div className="recap-block">
                <h4><span aria-hidden="true">◎</span> Look hardest at</h4>
                <ol>{focus.map((x, i) => <li key={i}>{x}</li>)}</ol>
              </div>
            )}
            {!risks.length && !focus.length && <p className="recap-none">{older ? 'not in this summary yet' : 'none found in the work so far'}</p>}
          </RecapSection>
          <div className="recap-grid">
            <div className="recap-block">
              <h3><span aria-hidden="true">☑</span> Tasks{tasks.length > 0 && <span className="recap-count"> {done} of {tasks.length} done</span>}</h3>
              {tasks.length > 0 && <div className="progress" role="img" aria-label={`${done} of ${tasks.length} tasks done`}><span style={{ width: `${(done / tasks.length) * 100}%`, background: pal.ready }} /></div>}
              {tasks.length ? (
                <ul className="tasks">
                  {tasks.map((t, i) => {
                    const look = TASK_LOOK[t.state] || TASK_LOOK.todo
                    return (
                      <li key={i} className={`task-${t.state}`} aria-label={`${look.word}: ${t.text}`}>
                        <span className="task-glyph" aria-hidden="true" style={t.state === 'done' ? { color: pal.ready } : t.state === 'doing' ? { color: pal.working } : undefined}>{look.glyph}</span>
                        <span>{t.text}{t.state === 'doing' && <span className="task-now" style={{ color: pal.working }}> now</span>}</span>
                      </li>
                    )
                  })}
                </ul>
              ) : <p className="recap-none">no tasks yet</p>}
            </div>
            <RecapList glyph="❗" word="Blockers" items={asList(r.blockers)} colour={asList(r.blockers).length ? pal.waiting : undefined} empty="none" />
          </div>
        </>
      )}
      {!r && shots.length > 0 && (
        <RecapSection n="3" title="How we know it works">
          <ul className="proof">{shots.map((s) => <ProofShot key={s.file} f={f} shot={s} />)}</ul>
        </RecapSection>
      )}
    </section>
  )
}

function SummaryTab({ f, repo, pal, say, onNew }) {
  const [brief, setBrief] = useState('')
  const notes = useDoc('notes', f.name)
  const root = useRef(null)
  const [sending, setSending] = useState(false)
  // what is selected anywhere in the tab goes to this feature's Claude, or seeds a new feature
  const act = async (choice, text) => {
    if (!text) return say('Select some text first', true)
    if (choice === 'new') return onNew(text)
    if (sending) return
    setSending(true)
    const r = await hub.grove(['send', f.name, text])
    setSending(false)
    say((r.code ? r.stderr || r.stdout : r.stdout).trim().replace(/^grove: /, ''), Boolean(r.code))
  }
  const menu = async (e) => {
    const text = selectionIn(root.current, e.target)
    const editable = e.target.tagName === 'TEXTAREA' && !e.target.disabled
    if (!text && !editable) return
    e.preventDefault()
    const choice = await hub.selectionMenu({ picked: Boolean(text), editable })
    if (choice) act(choice, text)
  }
  useEffect(() => {
    let live = true
    hub.brief(f.name).then((b) => live && setBrief(b))
    return () => { live = false }
  }, [f.name])
  const st = f.status.state || 'offline'
  const d = f.status.details || {}
  const git = d.git || {}
  const pr = f.pr
  const ci = pr && pr.state === 'OPEN' ? CI[pr.ci] || CI.none : null
  const stage = d.stage?.index ?? 0
  const ports = Object.entries(portsOf(f))
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const gitWords = [git.dirty && `${plural(git.dirty, 'file')} changed`, git.ahead && `${plural(git.ahead, 'commit')} ahead`, git.behind && `${plural(git.behind, 'commit')} behind`].filter(Boolean)
  const link = (url, label) => <a role="link" tabIndex={0} onClick={() => hub.open(url)} onKeyDown={(e) => e.key === 'Enter' && hub.open(url)}>{label}</a>
  const rows = [
    ['State', `${STATE[st].glyph} ${STATE[st].word}${d.note || f.status.message ? ` — ${d.note || f.status.message}` : ''}`],
    // the recap above already says what it is on and what comes next
    !f.recap && ['Working on', f.status.work ? `${f.status.work}${f.status.now ? ` — ${f.status.now}` : ''}` : 'No recap yet — it appears after Claude’s first turn'],
    !f.recap && ['Next', d.nextStep || f.status.next || 'give Claude its next instruction'],
    f.kind !== 'session' && ['Stage', `${STAGES[stage]} (${stage + 1} of 8)${d.stage?.note ? ` — ${d.stage.note}` : ''}`],
    ['Branch', f.branch || '?'],
    ['Where', f.kind === 'session' ? placeOf(f.path, repo) : (f.path || '').replace(/^\/Users\/[^/]+/, '~')],
    f.ticket && ['Ticket', f.ticket],
    f.parent && ['Spun off from', f.parent],
    ['Git', gitWords.length ? gitWords.join(', ') : 'clean, up to date'],
    ['Pull request', pr ? <>{link(pr.url, `#${pr.number}`)} · {pr.state.toLowerCase()}{ci && <> · <span style={{ color: ci[0] === 'ready' ? pal.ready : ci[0] }}>{ci[1]}</span></>}{pr.findings > 0 && ` · ${plural(pr.findings, 'review finding')}`}</> : 'none yet'],
    ports.length > 0 && ['Services', <>{ports.map(([svc, port], i) => <span key={svc}>{i > 0 && ' · '}{f.links?.[svc] ? link(f.links[svc], `${svc} :${port}`) : `${svc} :${port}`}</span>)}</>],
    f.createdAt && ['Started', new Date(f.createdAt).toLocaleString()],
  ].filter(Boolean)
  const task = taskOf(brief)
  return (
    <div className="doc summary" ref={root} onContextMenu={menu} aria-busy={sending}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !e.metaKey) return
        e.preventDefault()
        act(e.shiftKey ? 'new' : 'send', selectionIn(root.current))
      }}>
      <Recap f={f} pal={pal} />
      <h2>Facts</h2>
      <dl className="facts-list">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <h2>Task</h2>
      {task ? <pre className="task">{task}</pre> : <p className="busy">No task was given when this feature was created.</p>}
      <Scratchpad f={f} doc={notes} />
      <RetroSection f={f} say={say} />
    </div>
  )
}


// ---------- usage: what the status line hears from Claude Code (grove statusline → stats.json) ----------
const CONTEXT_NEAR = 80 // percent used: Claude compacts the conversation soon after (as the CLI says)
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))
const span = (ms) => {
  const m = Math.floor(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m ? `${m} min` : `${Math.floor(ms / 1000)} s`
}
const money = (usd) => `$${usd.toFixed(2)}`
// the last request, split by how it was billed; a word with every colour
const PARTS = [
  { key: 'cacheRead', word: 'Cached (read)', colour: '#6c9bd2', why: 'earlier turns Claude reused from the prompt cache' },
  { key: 'cacheWrite', word: 'Newly cached', colour: '#c79a5b', why: 'added to the cache this turn' },
  { key: 'input', word: 'Fresh input', colour: '#9a7fc4', why: 'sent uncached' },
]

function contextOf(stats) {
  const c = stats?.context || {}
  return { ...c, near: (c.percent ?? 0) >= CONTEXT_NEAR }
}

// beside the tabs: how full the context is and what it cost; opens the Usage tab
function UsageChip({ stats, onOpen }) {
  if (!stats) return null
  const c = contextOf(stats)
  const bits = [c.percent != null && `ctx ${Math.round(c.percent)}%${c.near ? ' near limit' : ''}`, stats.cost != null && money(stats.cost)].filter(Boolean)
  if (!bits.length) return null
  return (
    <button type="button" className={`usage-chip ${c.near ? 'near' : ''}`} onClick={onOpen}
      title={`Context ${c.used != null ? `${tokens(c.used)} of ${tokens(c.size)} tokens` : ''} — details in Usage (⌃3)`}>
      {bits.join(' · ')}
    </button>
  )
}

function UsageTab({ f, say, onClaude }) {
  const s = f.stats
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000)
    return () => clearInterval(t)
  }, [])
  if (!s) {
    return (
      <div className="doc usage">
        <h2>Usage</h2>
        <p className="busy">No usage yet — it appears once Claude Code shows its status line in this feature (after its first reply).</p>
      </div>
    )
  }
  const c = contextOf(s)
  const parts = c.parts || {}
  const known = c.used != null && c.size
  const ask = async (command) => {
    const r = await hub.grove(['send', f.name, command])
    if (r.code) return say((r.stderr || r.stdout).trim().replace(/^grove: /, ''), true)
    onClaude()
  }
  const rows = [
    ['Model', <>{s.model || '?'}{s.modelId && s.modelId !== s.model && <span className="dim"> ({s.modelId})</span>}</>],
    s.cost != null && ['Cost', `${money(s.cost)} this session`],
    s.durationMs != null && ['Time', `${span(s.durationMs)} in session${s.apiMs != null ? `, ${span(s.apiMs)} of it waiting on the model` : ''}`],
    (s.linesAdded != null || s.linesRemoved != null) && ['Lines', `+${s.linesAdded ?? 0} added, −${s.linesRemoved ?? 0} removed`],
    (c.totalIn != null || c.totalOut != null) && ['Tokens, all turns', `${tokens(c.totalIn ?? 0)} in, ${tokens(c.totalOut ?? 0)} out`],
    ...(s.rateLimits || []).map((l) => [`${l.label} limit`, `${Math.round(l.percent)}% used${l.resetsAt ? ` · resets ${new Date(typeof l.resetsAt === 'number' ? l.resetsAt * 1000 : l.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`]),
    s.version && ['Claude Code', s.version],
    s.outputStyle && ['Output style', s.outputStyle],
  ].filter(Boolean)
  return (
    <div className="doc usage">
      <div className="doc-bar">
        <h2>Context</h2>
        {s.updatedAt && <span className="recap-age">updated {ago(Date.parse(s.updatedAt))}</span>}
        <span className="grow" />
        <button className="btn" type="button" onClick={() => ask('/context')} title="Type /context into this feature's Claude: the breakdown by system prompt, tools, MCP, memory files and messages">
          Full breakdown in Claude (/context)
        </button>
      </div>
      {known ? (
        <>
          <p className="usage-big">
            <b>{tokens(c.used)}</b> of {tokens(c.size)} tokens · {Math.round(c.percent)}% used · {tokens(Math.max(c.size - c.used, 0))} left
            {c.near && <span className="usage-warn"> ⚠ Near the limit: Claude compacts the conversation soon. Type /compact at a good break, or hand off to a fresh feature.</span>}
          </p>
          <div className="meter" role="img" aria-label={`Context ${Math.round(c.percent)}% used: ${PARTS.filter((p) => parts[p.key]).map((p) => `${p.word} ${tokens(parts[p.key])}`).join(', ')}`}>
            {PARTS.map((p) => parts[p.key] > 0 && <span key={p.key} style={{ width: `${(parts[p.key] / c.size) * 100}%`, background: p.colour }} />)}
            {!PARTS.some((p) => parts[p.key] > 0) && <span style={{ width: `${c.percent}%`, background: PARTS[0].colour }} />}
            <i style={{ left: `${CONTEXT_NEAR}%` }} title={`${CONTEXT_NEAR}%: compaction soon`} />
          </div>
          <ul className="legend">
            {PARTS.filter((p) => parts[p.key] != null).map((p) => (
              <li key={p.key}><span className="swatch" style={{ background: p.colour }} />{p.word} <b>{tokens(parts[p.key])}</b> <span className="dim">— {p.why}</span></li>
            ))}
            {parts.output != null && <li><span className="swatch none" />Last reply <b>{tokens(parts.output)}</b> <span className="dim">— joins the context next turn</span></li>}
          </ul>
        </>
      ) : <p className="busy">{c.percent != null ? `${Math.round(c.percent)}% of the context used.` : 'This Claude Code version does not report context use; update it, or use /context.'}</p>}
      <h2>Session</h2>
      <dl className="facts-list">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </div>
  )
}

// ---------- app ----------
// ---------- bringing in work that is already in flight (grove import) ----------
const STALE_DAYS = 21
const keyOf = (item) => item.path || item.id
const home = (dir) => dir.replace(/^\/Users\/[^/]+/, '~')
const humanize = (branch) => {
  const tail = branch.split('/').pop().replace(/[-_]+/g, ' ').trim()
  return tail.charAt(0).toUpperCase() + tail.slice(1)
}
// quiet for weeks with nothing uncommitted: likely finished or abandoned (old branches are often
// still "ahead" after a squash merge), so listed but not ticked
const isStale = (t) => !t.dirty && (Date.now() / 1000 - t.at) > STALE_DAYS * 86400
// a conversation is likely still going if it has a title and moved in the last day
const isLive = (c) => Boolean(c.title) && (Date.now() / 1000 - c.at) < 86400
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const failedKeys = (scan) => new Set((scan?.failures || []).map(keyOf))
const worthIt = (item) => (item.path ? !isStale(item) : isLive(item))
const outside = (scan, dismissed) => scan && !scan.error
  ? [...scan.worktrees, ...scan.sessions].filter((item) => !dismissed.includes(keyOf(item)) && worthIt(item) && !failedKeys(scan).has(keyOf(item)))
  : []

function SetupSummary({ config, project, onSetup }) {
  const svc = config.services
  const st = config.setup
  const lines = [
    ...(st.link?.length ? [['Linked from the main checkout', st.link.join(', ')]] : []),
    ...(st.clone?.length ? [['Copied in (copy-on-write, fast)', st.clone.join(', ')]] : []),
    ...(st.copy?.length ? [['Copied once', st.copy.join(', ')]] : []),
    ...(st.run?.length ? [['Then runs', st.run.join(' · ')]] : []),
  ]
  return (
    <>
    <details className="setup">
      <summary>
        <b>How Grove will run them</b>
        <span>{svc.length ? `${svc.map((x) => x.name).join(' and ')}, each on its own port` : 'a Claude session and a shell (no dev servers found)'}
          {' · '}{{ '.grove.json': "from the repo's .grove.json", 'project.json': 'from your project.json', starter: 'guessed from the repo', invalid: "the repo's .grove.json is broken (not a JSON object), so it is ignored" }[config.source]}</span>
      </summary>
      <dl className="facts-list">
        {svc.map((x) => (
          <div key={x.name}><dt>{x.name}</dt><dd><code>{x.dir || '.'}</code> · <code>{x.run.replace(/^exec /, '')}</code> · ports {x.ports[0]}–{x.ports[1]}, {x.free} free</dd></div>
        ))}
        {lines.map(([what, value]) => <div key={what}><dt>{what}</dt><dd><code>{value}</code></dd></div>)}
      </dl>
      <p className="hint">
        {config.source === 'starter' ? 'Wrong guess? Fix it in ' : 'Your own changes go in '}
        <a role="link" tabIndex={0} onClick={() => hub.openConfig(project)} onKeyDown={(e) => e.key === 'Enter' && hub.openConfig(project)}>project.json</a>
        {' '}before bringing work in; it applies to every feature from then on.
      </p>
    </details>
    {config.setupWithClaude && onSetup && (
      <div className="setup-offer">
        <button className="btn" type="button" onClick={onSetup}>Set up with Claude</button>
        <span className="hint">{config.source === 'starter' ? 'That is a quick guess from a few file checks. ' : ''}A Claude session can read the repo and fill in your project.json: dev servers, ports, env files that point at other services, setup and checks.</span>
      </div>
    )}
    </>
  )
}

function ImportSheet({ scan, justAdded, dismissed, onClose, onDone, onSetup }) {
  const items = [...scan.worktrees, ...scan.sessions]
  const [picked, setPicked] = useState(() => new Set(items
    .filter((item) => !dismissed.includes(keyOf(item)) && worthIt(item)).map(keyOf)))
  const [progress, setProgress] = useState({}) // key -> 'busy' | 'done' | error text
  const [running, setRunning] = useState(false)
  const first = useRef(null)
  useEffect(() => { first.current?.focus() }, [])
  const flip = (key) => setPicked((all) => {
    const next = new Set(all)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  // a retry after a partial failure leaves out what already came in
  const trees = scan.worktrees.filter((t) => picked.has(t.path) && progress[t.path] !== 'done')
  const chats = scan.sessions.filter((c) => picked.has(c.id) && progress[c.id] !== 'done')
  const count = trees.length + chats.length
  // a service with fewer free ports than worktrees ticked: the rest would fail, so say so up front
  const short = scan.config.services.filter((x) => x.free < trees.length)

  const bringIn = async () => {
    if (!count || running) return
    setRunning(true)
    const made = []
    const failed = [] // what could not come in, with the error, for the Fix import brief
    const step = async (item, args, pattern) => {
      const key = keyOf(item)
      setProgress((p) => ({ ...p, [key]: 'busy' }))
      const r = await hub.grove(args)
      const name = pattern.exec(r.stdout)?.[1]
      const error = (r.stderr || r.stdout).trim() || 'failed'
      setProgress((p) => ({ ...p, [key]: name && !r.code ? 'done' : error }))
      if (name && !r.code) made.push(name)
      else failed.push({ ...(item.path ? { path: item.path, branch: item.branch } : { id: item.id }), title: item.conversation?.title || item.title || '', error })
    }
    for (const t of trees) await step(t, ['adopt', t.path, '--project', scan.project], /^([a-z0-9][a-z0-9._-]*): adopted /m)
    for (const c of chats) await step(c, ['adopt', '--session', c.id], /^(s-[0-9a-f]{8}): /m)
    setRunning(false)
    // whatever came in is ready to use; what didn't is kept for Fix with Claude, not left on screen
    onDone(made, { trees: trees.length - failed.filter((x) => x.path).length, chats: chats.length - failed.filter((x) => x.id).length },
      items.map(keyOf).filter((k) => !picked.has(k)), failed)
  }

  const status = (key) => {
    const st = progress[key]
    if (!st) return null
    if (st === 'busy') return <span className="tag busy">bringing in…</span>
    if (st === 'done') return <span className="tag ok">✓ in Grove</span>
    return <span className="tag bad" title={st}>✗ {st.split('\n')[0].slice(0, 80)}</span>
  }
  const row = (item, i, body) => (
    <li key={keyOf(item)}>
      <label className={`pick ${picked.has(keyOf(item)) ? 'on' : ''}`}>
        <input type="checkbox" ref={i === 0 ? first : undefined} checked={picked.has(keyOf(item))} disabled={running || progress[keyOf(item)] === 'done'}
          onChange={() => flip(keyOf(item))} />
        <span className="pick-text">{body}</span>
        {status(keyOf(item))}
      </label>
    </li>
  )

  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose(items.map(keyOf))}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="import-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !running) onClose(items.map(keyOf))
          if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); bringIn() }
        }}>
        <h1 id="import-title">{items.length ? 'Bring your work into Grove' : `${scan.project} is ready`}</h1>
        <p className="sheet-sub">
          {justAdded ? <>Added <b>{scan.project}</b>. </> : null}
          {items.length ? `Grove found ${[scan.worktrees.length && plural(scan.worktrees.length, 'worktree'), scan.sessions.length && plural(scan.sessions.length, 'Claude conversation')].filter(Boolean).join(' and ')} in progress in ` : 'Everything in '}
          <code>{home(scan.repo)}</code>{items.length ? '.' : ' is already in Grove.'}
        </p>

        {scan.worktrees.length > 0 && (
          <>
            <h2>Worktrees <span>each becomes a feature with its own ports and Claude session; your code and branch stay as they are</span></h2>
            <ul className="picks">
              {scan.worktrees.map((t, i) => row(t, i, (
                <>
                  <span className="pick-title">{t.conversation?.title || humanize(t.branch)}</span>
                  <span className="pick-sub">⎇ {t.branch} · {home(t.path)}</span>
                  <span className="tags">
                    {t.path.includes('/.claude/worktrees/') && <span className="tag">made by a Claude Code agent</span>}
                    {t.dirty && <span className="tag warn">uncommitted changes</span>}
                    {t.ahead > 0 && <span className="tag">{plural(t.ahead, 'commit')} ahead</span>}
                    {t.ahead === 0 && !t.dirty && <span className="tag">no new commits</span>}
                    {t.conversation && <span className="tag">Claude conversation · {ago(t.conversation.at * 1000)}</span>}
                    {isStale(t) && <span className="tag">quiet for {Math.floor((Date.now() / 1000 - t.at) / 86400)} days</span>}
                    {!isStale(t) && !t.conversation && t.at > 0 && <span className="tag">last commit {ago(t.at * 1000)}</span>}
                  </span>
                </>
              )))}
            </ul>
          </>
        )}

        {scan.sessions.length > 0 && (
          <>
            <h2>Claude conversations in the main checkout <span>each moves here and resumes with its full history</span></h2>
            <ul className="picks">
              {scan.sessions.map((c, i) => row(c, scan.worktrees.length + i, (
                <>
                  <span className="pick-title">{c.title || `Conversation ${c.id.slice(0, 8)}`}</span>
                  <span className="pick-sub">◷ {c.folder || 'main checkout'}{c.branch ? ` · ⎇ ${c.branch}` : ''} · {ago(c.at * 1000)}</span>
                  {!isLive(c) && <span className="tags"><span className="tag">{c.title ? 'quiet for a day or more' : 'untitled: probably a quick one-off'}</span></span>}
                </>
              )))}
            </ul>
            <p className="hint">A conversation can run in one place at a time: after bringing it in, type <code>/exit</code> where it is running now, then press Enter in its Grove panel.</p>
          </>
        )}

        {(items.length > 0 || scan.config.source === 'starter') && <SetupSummary config={scan.config} project={scan.project} onSetup={onSetup} />}

        {short.length > 0 && (
          <p className="sheet-warn" role="status">
            ⚠ {short.map((x) => `${x.name} has ${x.free} free port${x.free === 1 ? '' : 's'} (${x.ports[0]}–${x.ports[1]})`).join(', ')} for {plural(trees.length, 'worktree')}.
            {' '}Widen the range in <a role="link" tabIndex={0} onClick={() => hub.openConfig(scan.project)} onKeyDown={(e) => e.key === 'Enter' && hub.openConfig(scan.project)}>project.json</a> first,
            or bring them in anyway: the rest wait under “Fix with Claude”.
          </p>
        )}
        <div className="sheet-actions">
          {items.length > 0 && (
            <button className="btn primary" type="button" disabled={!count || running} onClick={bringIn}>
              {running ? 'Bringing in…' : count ? `Bring in ${count}  ⌘↩` : 'Pick something to bring in'}
            </button>
          )}
          <button className="btn" type="button" disabled={running} onClick={() => onClose(items.map(keyOf))}>{items.length ? 'Not now  esc' : 'Close  esc'}</button>
        </div>
      </section>
    </div>
  )
}

// ---------- what could not come in: shown, then handed to a briefed Claude session on request ----------
function FixSheet({ project, onClose, onStarted, onChanged }) {
  const [draft, setDraft] = useState(null)
  const [brief, setBrief] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const r = await hub.grove(['fix-import', '--project', project, '--draft', '--json'])
    try {
      const d = JSON.parse(r.stdout)
      setDraft(d)
      setBrief(d.brief)
    } catch { setError((r.stderr || r.stdout).trim() || 'could not read what failed') }
  }, [project])
  useEffect(() => { load() }, [load])
  const fixable = draft ? draft.failures.filter((x) => x.fixable) : []
  const start = async () => {
    if (!brief.trim() || starting) return
    setStarting(true)
    const r = await hub.grove(['fix-import', '--project', project, '--start', '-p', brief])
    setStarting(false)
    const name = /^([a-z0-9][a-z0-9._-]*): /m.exec(r.stdout)?.[1]
    if (r.code || !name) return setError((r.stderr || r.stdout).trim())
    onStarted(name)
  }
  const forget = async (key) => {
    await hub.grove(['fix-import', '--project', project, '--forget', key])
    onChanged()
    load()
  }
  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="fix-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); start() }
        }}>
        <h1 id="fix-title">Fix what couldn't come in</h1>
        {!draft && !error && <p className="busy">Looking at what failed…</p>}
        {draft && (
          <>
            <ul className="picks">
              {draft.failures.map((x) => (
                <li key={keyOf(x)}>
                  <div className="pick on">
                    <span className="pick-text">
                      <span className="pick-title">{x.title || (x.path ? humanize(x.branch || x.path) : `Conversation ${x.id.slice(0, 8)}`)}</span>
                      <span className="pick-sub">{x.path ? `⎇ ${x.branch} · ${home(x.path)}` : `◷ conversation ${x.id.slice(0, 8)}`}</span>
                      <span className="fail-error">✗ {(x.error || '').split('\n').filter(Boolean).slice(-1)[0]}</span>
                      {!x.fixable && <span className="tags"><span className="tag">can't come in: {x.why}</span></span>}
                    </span>
                    {!x.fixable && <button className="btn" type="button" onClick={() => forget(keyOf(x))}>Forget it</button>}
                  </div>
                </li>
              ))}
            </ul>
            {fixable.length > 0 ? (
              <>
                <label className="brief-label" htmlFor="fix-brief">What Claude will be asked <span>edit it if you like; it starts only when you say so</span></label>
                <textarea id="fix-brief" className="doc-text brief" value={brief} onChange={(e) => setBrief(e.target.value)} spellCheck={false} autoFocus />
                <p className="hint">Claude works in its own session, <b>Fix import</b>, under Sessions in the sidebar. It asks before changing anything, as Claude Code always does, and is told to leave your code, worktrees and branches alone.</p>
              </>
            ) : draft.failures.length === 0 ? <p className="sheet-sub">Everything that failed is in Grove now.</p> : null}
          </>
        )}
        {error && <p className="sheet-error">{error}</p>}
        <div className="sheet-actions">
          {fixable.length > 0 && (
            <button className="btn primary" type="button" disabled={starting || !brief.trim()} onClick={start}>
              {starting ? 'Starting…' : 'Start fixing with Claude  ⌘↩'}
            </button>
          )}
          <button className="btn" type="button" onClick={onClose}>{fixable.length ? 'Not now  esc' : 'Close  esc'}</button>
        </div>
      </section>
    </div>
  )
}

// ---------- a Claude session that reads the repo and writes a better project.json, on request ----------
function SetupSheet({ project, onClose, onStarted }) {
  const [brief, setBrief] = useState(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    hub.grove(['project', 'setup', project, '--draft', '--json']).then((r) => {
      try { setBrief(JSON.parse(r.stdout).brief) } catch { setError((r.stderr || r.stdout).trim() || 'could not draft the brief') }
    })
  }, [project])
  const start = async () => {
    if (!brief?.trim() || starting) return
    setStarting(true)
    const r = await hub.grove(['project', 'setup', project, '--start', '-p', brief])
    setStarting(false)
    const name = /^([a-z0-9][a-z0-9._-]*): /m.exec(r.stdout)?.[1]
    if (r.code || !name) return setError((r.stderr || r.stdout).trim())
    onStarted(name)
  }
  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="setup-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); start() }
        }}>
        <h1 id="setup-title">Set up {project} with Claude</h1>
        <p className="sheet-sub">Grove guessed how to run this repo from a few file checks. Claude can read it properly and fill in your project.json, so each feature gets its own servers, ports and env files.</p>
        {brief === null && !error && <p className="busy">Drafting the brief…</p>}
        {brief !== null && (
          <>
            <label className="brief-label" htmlFor="setup-brief">What Claude will be asked <span>edit it if you like; it starts only when you say so</span></label>
            <textarea id="setup-brief" className="doc-text brief" value={brief} onChange={(e) => setBrief(e.target.value)} spellCheck={false} autoFocus />
            <p className="hint">Claude works in its own session, <b>Set up {project}</b>, under Sessions in the sidebar. It writes only your project.json, leaves the repo and its .grove.json alone, and asks before changing anything.</p>
          </>
        )}
        {error && <p className="sheet-error">{error}</p>}
        <div className="sheet-actions">
          {brief !== null && (
            <button className="btn primary" type="button" disabled={starting || !brief.trim()} onClick={start}>
              {starting ? 'Starting…' : 'Start setting up with Claude  ⌘↩'}
            </button>
          )}
          <button className="btn" type="button" onClick={onClose}>Not now  esc</button>
        </div>
      </section>
    </div>
  )
}

// every shortcut in one place (Help › Keyboard Shortcuts, ⌘/); panel keys come from the current feature
function ShortcutsSheet({ panels, onClose }) {
  const groups = [
    ['Features', [
      ['⌘1–9', 'Switch to the 1st–9th feature'], ['⌘N', 'New feature'], ['⌘E', 'Rename the feature'],
      ['⌘K', 'Find a feature'], ['⌘⇧R', 'Restart its services'], ['⌘⇧F', 'Fix the feature'],
    ]],
    ['Projects', [['⌘⇧1–9', 'Open a project'], ['⌘⇧O', 'Add a project'], ['⌘⇧I', 'Bring in existing work']]],
    ['Panels and tabs', [
      ...(panels.length ? panels.filter((p) => p.key).map((p) => [`⌘⌥${p.key.toUpperCase()}`, `Open or close ${p.name}`]) : [['⌘⌥ + key', 'Open or close a panel (its key shows on its button)']]),
      ['⌘⇧↩', 'Zoom the last panel, or restore it'], ['⌃1–3', 'Claude, Summary and Usage tabs'],
    ]],
    ['Screenshots for the agent', [
      ['⌘⇧S', 'Drag a region'], ['⌘⌥⇧S', 'Click a window'], ['⌘V', 'Paste a copied image into a terminal'],
    ]],
    ['In sheets and terminals', [
      ['⌘↩', 'Confirm (create, bring in, start)'], ['esc', 'Close the sheet'], ['⌥-drag', 'Select text inside a terminal'],
      ['⌘/', 'This list'],
    ]],
  ]
  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet keys-sheet" role="dialog" aria-modal="true" aria-labelledby="keys-title" tabIndex={-1}
        ref={(el) => el?.focus()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h1 id="keys-title">Keyboard shortcuts</h1>
        <p className="sheet-sub">Also in the menu bar next to each command. Right-click a feature for more.</p>
        <div className="keys-grid">
          {groups.map(([title, rows]) => (
            <div key={title}>
              <h2>{title}</h2>
              <dl className="keys">
                {rows.map(([k, what]) => <div key={k + what}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>)}
              </dl>
            </div>
          ))}
        </div>
        <div className="sheet-actions">
          <button className="btn" type="button" onClick={onClose}>Close  esc</button>
        </div>
      </section>
    </div>
  )
}

function App() {
  const [state, setState] = useState({ features: [], palette: {} })
  const [current, setCurrent] = useState(() => localStorage.getItem(`current:${hub.project}`) || '')
  const [hosted, setHosted] = useState({}) // name -> { pane: { session, hint } }
  const [openPanels, setOpenPanels] = useState(() => {
    try { return JSON.parse(localStorage.getItem('open') || '{}') } catch { return {} }
  })
  const [zoom, setZoom] = useState(null)
  const [tabs, setTabs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tabs') || '{}') } catch { return {} }
  }) // feature -> main panel tab
  const [renaming, setRenaming] = useState(null)
  const [keysOpen, setKeysOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [seed, setSeed] = useState('') // a task to start the new-feature form with (from the scratchpad)
  const [creating, setCreating] = useState(null)
  const [toast, setToast] = useState(null)
  const filterRef = useRef(null)
  // work on this repo that Grove is not running yet (grove import --json), and what was set aside
  const [scan, setScan] = useState(null)
  const [sheet, setSheet] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [settingUp, setSettingUp] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`dismissed:${hub.project}`) || '[]') } catch { return [] }
  })
  const rescan = useCallback(async () => {
    if (!hub.project) return null
    const found = await hub.scanImport(hub.project)
    setScan(found)
    return found
  }, [])
  // quiet: on opening a project just added, only show the sheet when there is something to bring in
  const review = useCallback(async (quiet = false) => {
    const found = await rescan()
    if (found?.error) return say(found.error, true)
    if (!found) return
    if (quiet && !found.worktrees.length && !found.sessions.length && found.config?.source !== 'starter') {
      return say(`${found.project} is ready. Nothing of it is running outside Grove: start a feature with ⌘N.`)
    }
    setSheet(true)
  }, [rescan])
  useEffect(() => {
    if (!hub.project) return
    if (hub.review) review(true)
    else rescan()
    let last = Date.now()
    const onFocus = () => { if (Date.now() - last > 60000) { last = Date.now(); rescan() } }
    window.addEventListener('focus', onFocus)
    const timer = setInterval(rescan, 5 * 60000)
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer) }
  }, [])
  const setAside = (keys) => {
    const next = [...new Set([...dismissed, ...keys])]
    setDismissed(next)
    localStorage.setItem(`dismissed:${hub.project}`, JSON.stringify(next))
  }

  useEffect(() => {
    hub.state(hub.project).then(setState)
    hub.onState(setState)
  }, [])
  const features = state.features
  // a feature created anywhere (Claude's new_feature tool, grove new, + New) gets the focus once
  const startedAt = useRef(Date.now() / 1000)
  const seenFocus = useRef(0)
  useEffect(() => {
    const focus = state.focus
    if (!focus || focus.at <= startedAt.current || focus.at <= seenFocus.current) return
    if (!features.some((x) => x.name === focus.name)) return
    seenFocus.current = focus.at
    setCurrent(focus.name)
    setZoom(null)
  }, [state])
  const f = features.find((x) => x.name === current) || features[0]
  useEffect(() => {
    if (f && f.name !== current) setCurrent(f.name)
  }, [f?.name])
  useEffect(() => { if (current) localStorage.setItem(`current:${hub.project}`, current) }, [current])
  useEffect(() => { localStorage.setItem('open', JSON.stringify(openPanels)) }, [openPanels])
  useEffect(() => { localStorage.setItem('tabs', JSON.stringify(tabs)) }, [tabs])
  const tab = (f && TABS.some((t) => t.id === tabs[f.name]) && tabs[f.name]) || 'claude'
  const setTab = useCallback((t) => f && setTabs((all) => ({ ...all, [f.name]: t })), [f?.name])

  const say = (text, isError = false) => {
    setToast({ text, isError })
    setTimeout(() => setToast(null), isError ? 9000 : 3500)
  }
  notify = say

  // every feature shown gets its tmux sessions (idempotent; adopts panes from the tmux UI)
  useEffect(() => {
    if (!f || hosted[f.name]) return
    hub.host(f.name).then((res) => {
      if (!Array.isArray(res)) return say(`Could not start ${f.name}: ${res.error}`, true)
      setHosted((h) => ({ ...h, [f.name]: Object.fromEntries(res.map((r) => [r.pane, r])) }))
    })
  }, [f?.name, hosted])

  const open = f ? openPanels[f.name] || [] : []
  const toggle = useCallback((panel) => {
    if (!f) return
    setOpenPanels((all) => {
      const list = all[f.name] || []
      return { ...all, [f.name]: list.includes(panel) ? list.filter((p) => p !== panel) : [...list, panel] }
    })
    setZoom((z) => (z === panel ? null : z))
  }, [f?.name])

  const rename = async (name, title) => {
    setRenaming(null)
    if (!title.trim()) return
    const r = await hub.grove(['rename', name, ...title.trim().split(/\s+/)])
    if (r.code) say(r.stderr || r.stdout, true)
  }
  const create = async (name, task) => {
    setNewOpen(false)
    setCreating(name)
    const r = await hub.grove(['new', name, ...(state.project ? ['--project', state.project] : []), ...(task ? ['-p', task] : [])])
    setCreating(null)
    if (r.code) return say((r.stderr || r.stdout).trim(), true)
    // grove new turns a typed phrase into a name ("Main panel tabs" → main-panel-tabs) and says it first: "<name>: <worktree> [<branch>]"
    setCurrent(/^([a-z0-9][a-z0-9._-]*): \S+ \[/m.exec(r.stdout)?.[1] || name.toLowerCase())
    say(r.stdout.trim())
  }
  // grove fix repairs only what is broken; panes it had to recreate need their terminals attached again
  const [repairing, setRepairing] = useState(null)
  // features being closed: name -> { word, detail, since }. grove done takes a while (servers, tmux,
  // worktree, branch), so the row and the work area show it until the feature leaves the list
  const [closing, setClosing] = useState({})
  const markClosing = (name, word, detail) => setClosing((c) => {
    const next = { ...c }
    if (word) next[name] = { word, detail, since: c[name]?.since || Date.now() }
    else delete next[name]
    return next
  })
  const repair = async (feat) => {
    setRepairing(feat.name)
    const r = await hub.grove(['fix', feat.name])
    setRepairing(null)
    say((r.stdout || r.stderr).trim(), Boolean(r.code))
    if (!r.code && !/: nothing to fix/.test(r.stdout)) setHosted((h) => ({ ...h, [feat.name]: undefined }))
  }
  const rowMenu = async (feat) => {
    const choice = await hub.rowMenu({ name: feat.name, prUrl: feat.pr?.url, links: feat.links })
    if (choice === 'rename') setRenaming(feat.name)
    if (choice === 'restart') {
      const r = await hub.grove(['restart', feat.name])
      say((r.stdout || r.stderr).trim(), Boolean(r.code))
    }
    if (choice === 'fix') repair(feat)
    if (choice?.startsWith('open:')) hub.open(choice.slice(5))
    if (choice === 'open-pr') hub.open(feat.pr.url)
    if (choice === 'reveal') hub.reveal(feat.path)
    if (choice === 'done') {
      // a merged, committed feature just goes; anything that might lose work asks first
      markClosing(feat.name, 'Checking', 'Looking for uncommitted or unmerged work')
      const c = await hub.grove(['done', feat.name, '--check'])
      markClosing(feat.name, null)
      let why = []
      try { why = JSON.parse(c.stdout).reasons || [] } catch { why = [(c.stderr || 'could not check it').trim()] }
      const args = ['done', feat.name]
      if (why.length) {
        const pick = await hub.ask(`${feat.title} may not be finished`,
          `${why.map((w) => `• ${w}`).join('\n')}\n\nDelete anyway removes its worktree, branch (with any unmerged commits), servers and Claude session. Notes and retro are kept in the project's archive.`,
          ['Delete anyway', 'Close, keep worktree and branch', 'Cancel'])
        if (pick === 2) return
        args.push(pick === 0 ? '--force' : '--keep')
      }
      markClosing(feat.name, 'Closing', args.includes('--keep')
        ? 'Stopping its servers and Claude session · keeping the worktree and branch'
        : 'Stopping its servers and Claude session · removing the worktree and branch')
      const r = await hub.grove(args)
      say((r.stdout || r.stderr).trim(), Boolean(r.code))
      setHosted((h) => ({ ...h, [feat.name]: undefined }))
      // on success the row goes when the state file watcher drops it; the timeout is a fallback
      if (r.code) markClosing(feat.name, null)
      else setTimeout(() => markClosing(feat.name, null), 5000)
    }
  }

  // menu accelerators and ⌘1…9
  const latest = useRef({})
  latest.current = { f, features, toggle, open, zoom, setTab, review, repair, sessionsNow: f ? hosted[f.name] : null }
  useEffect(() => {
    hub.onMenu(async (action) => {
      const { f, toggle, open, zoom } = latest.current
      if (action === 'keys') setKeysOpen((v) => !v)
      if (action === 'new') setNewOpen(true)
      if (action === 'import') latest.current.review()
      if (action === 'find') filterRef.current?.focus()
      if (action === 'rename' && f) setRenaming(f.name)
      if (action === 'restart' && f) {
        const r = await hub.grove(['restart', f.name])
        say((r.stdout || r.stderr).trim(), Boolean(r.code))
      }
      if (action === 'fix' && f) latest.current.repair(f)
      if (action.startsWith('shot') && f) {
        const t = terms.get(`${f.name}:claude`)
        if (t?.started) shotInto(t, action === 'shot:window' ? 'window' : 'region')
        else say(`${f.title || f.name}: its Claude session is not open yet`, true)
      }
      if (action.startsWith('toggle:')) toggle(action.slice(7))
      if (action === 'zoom') setZoom(zoom ? null : open[open.length - 1] || null)
    })
    const onKey = (e) => {
      if (e.metaKey && e.altKey && !e.shiftKey && /^Key[A-Z]$/.test(e.code)) {
        const key = e.code.slice(3).toLowerCase()
        const { f, sessionsNow } = latest.current
        const panel = sessionsNow && Object.values(sessionsNow).find((s) => s.pane !== 'claude' && s.key === key)
        if (f && panel) {
          e.preventDefault()
          latest.current.toggle(panel.pane)
        }
        return
      }
      // ⌃1…4: main panel tabs (taken before the terminal sees them)
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const t = TABS[Number(e.code.slice(5)) - 1]
        if (t && latest.current.f) {
          e.preventDefault()
          e.stopPropagation()
          latest.current.setTab(t.id)
        }
        return
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const target = latest.current.features[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          setCurrent(target.name)
          setZoom(null)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const pal = state.palette
  const vars = {
    '--band': pal.band, '--name': pal.name, '--accent': pal.accent, '--off': pal.off,
    '--waiting': pal.waiting, '--working': pal.working, '--ready': pal.ready,
  }
  const sessions = f ? hosted[f.name] : null

  return (
    <div className="app" style={vars}>
      <Sidebar project={state.project} repo={state.repo || ''} elsewhere={Object.values(state.waitingElsewhere || {}).reduce((a, b) => a + b, 0)} features={features} current={f?.name} onPick={(n) => { setCurrent(n); setZoom(null) }} onMenu={rowMenu}
        renaming={renaming} setRenaming={setRenaming} onRename={rename}
        newOpen={newOpen} setNewOpen={(v) => { if (!v) setSeed(''); setNewOpen(v) }} seed={seed} onCreate={create} creating={creating} closing={closing} filterRef={filterRef}
        waitingOutside={outside(scan, dismissed).length} onReview={() => review()}
        failedCount={scan?.failures?.length || 0} onFix={() => setFixing(true)} onKeys={() => setKeysOpen(true)} />
      <main className="main">
        {!f && (
          <div className="empty">
            {state.project && outside(scan, dismissed).length > 0 ? (
              <>
                <h1>Bring in your work from {state.project}</h1>
                <p>{(() => {
                  const out = outside(scan, dismissed)
                  const t = out.filter((x) => x.path).length
                  const c = out.length - t
                  return [t && plural(t, 'worktree'), c && plural(c, 'Claude conversation')].filter(Boolean).join(' and ')
                })()} in progress outside Grove.</p>
                <div className="empty-actions">
                  <button className="btn primary" type="button" onClick={() => review()}>Review and bring in  ⌘⇧I</button>
                  <button className="btn" type="button" onClick={() => setNewOpen(true)}>New feature  ⌘N</button>
                </div>
              </>
            ) : state.project ? (
              <>
                <h1>No features in {state.project} yet</h1>
                <p>Each feature gets a worktree, its own ports, services and a Claude session.</p>
                <button className="btn primary" type="button" onClick={() => setNewOpen(true)}>New feature  ⌘N</button>
              </>
            ) : (
              <>
                <h1>Add a project to begin</h1>
                <p>Choose a git repository. Grove then shows the work already in flight on it (worktrees, Claude conversations) so you can bring it in.</p>
                <button className="btn primary" type="button" onClick={() => hub.addProject()}>Add project  ⌘⇧O</button>
              </>
            )}
          </div>
        )}
        {f && (
          <>
            <Header repo={state.repo || ''} f={f} pal={pal} panels={sessions ? Object.values(sessions).filter((s) => s.pane !== 'claude').map((s) => ({ name: s.pane, key: s.key })) : []} openList={open} onToggle={toggle}
              onFix={() => repair(f)} fixing={repairing === f.name} />
            <div className="work" inert={closing[f.name] ? '' : undefined}>
              {closing[f.name] && <ClosingCover f={f} job={closing[f.name]} />}
              <div className="left">
                <TabBar tab={tab} onTab={setTab} stats={f.stats} />
                {/* the terminal stays mounted under the other tabs so it keeps its tmux attachment */}
                <section className="claude" id="tabpanel-claude" role="tabpanel" aria-labelledby="tab-claude" hidden={tab !== 'claude'}>
                  {sessions?.claude ? <TerminalView termKey={`${f.name}:claude`} session={sessions.claude.session} focus={!zoom && tab === 'claude'} />
                    : <div className="empty"><p className="busy">Starting {f.title}…</p></div>}
                </section>
                {tab !== 'claude' && (
                  <section className="tabpanel" id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
                    {tab === 'summary' && <SummaryTab key={f.name} f={f} repo={state.repo || ''} pal={pal} say={say}
                      onNew={(text) => { setSeed(text); setNewOpen(true) }} />}
                    {tab === 'usage' && <UsageTab f={f} say={say} onClaude={() => setTab('claude')} />}
                  </section>
                )}
              </div>
              {open.length > 0 && sessions && (
                <div className="panels">
                  {open.map((p) => sessions[p] && (
                    <section key={p} className={`panel ${zoom === p ? 'zoomed' : ''}`} aria-label={`${p} panel`}>
                      <div className="panel-bar">
                        <span className="pname">─ {p}</span>
                        <span className="phint">{sessions[p].hint}</span>
                        <button className="iconbtn" type="button" title={zoom === p ? 'Restore (⌘⇧↩)' : 'Zoom (⌘⇧↩)'} aria-label={zoom === p ? `Restore ${p}` : `Zoom ${p}`}
                          onClick={() => setZoom(zoom === p ? null : p)}>{zoom === p ? '⤡' : '⤢'}</button>
                        <button className="iconbtn" type="button" title="Close panel" aria-label={`Close ${p}`} onClick={() => toggle(p)}>✕</button>
                      </div>
                      <TerminalView termKey={`${f.name}:${p}`} session={sessions[p].session} focus={zoom === p} />
                    </section>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
      {sheet && scan && !scan.error && (
        <ImportSheet scan={scan} justAdded={hub.review && !features.length} dismissed={dismissed}
          onClose={(keys) => { setAside(keys); setSheet(false) }} onSetup={() => setSettingUp(true)}
          onDone={async (made, counts, skipped, failed) => {
            setAside(skipped)
            setSheet(false)
            if (failed.length) await hub.grove(['fix-import', '--project', scan.project, '--record', JSON.stringify(failed)])
            rescan()
            if (made[0]) { setCurrent(made[0]); setZoom(null) }
            const brought = [counts.trees && plural(counts.trees, 'worktree'), counts.chats && plural(counts.chats, 'conversation')].filter(Boolean).join(' and ')
            say([brought && `Brought in ${brought}.`,
              failed.length && `${failed.length} couldn't come in: “Fix with Claude” in the sidebar shows why and can sort it out.`,
              counts.chats > 0 && 'Type /exit where each conversation runs now, then press Enter in its panel.'].filter(Boolean).join(' '), failed.length > 0 && !made.length)
          }} />
      )}
      {settingUp && scan && (
        <SetupSheet project={scan.project} onClose={() => setSettingUp(false)}
          onStarted={(name) => { setSettingUp(false); setSheet(false); setCurrent(name); setZoom(null); rescan() }} />
      )}
      {fixing && scan && (
        <FixSheet project={scan.project} onClose={() => setFixing(false)} onChanged={rescan}
          onStarted={(name) => { setFixing(false); setCurrent(name); setZoom(null); rescan() }} />
      )}
      {keysOpen && <ShortcutsSheet panels={sessions ? Object.values(sessions).filter((s) => s.pane !== 'claude').map((s) => ({ name: s.pane, key: s.key })) : []}
        onClose={() => setKeysOpen(false)} />}
      {toast && <div className={`toast ${toast.isError ? 'error' : ''}`} role="status">{toast.text}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
