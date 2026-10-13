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
function Sidebar({ project, repo, elsewhere, features, current, onPick, onMenu, renaming, setRenaming, onRename, newOpen, setNewOpen, onCreate, creating, filterRef }) {
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState('')
  const [newName, setNewName] = useState('')
  const [task, setTask] = useState('')
  useEffect(() => {
    const f = features.find((x) => x.name === renaming)
    if (f) setDraft(f.title)
  }, [renaming])
  const q = filter.trim().toLowerCase()
  const shown = features.filter((f) => !q || f.title.toLowerCase().includes(q) || f.name.includes(q) || (f.ticket || '').toLowerCase().includes(q))
  const create = () => {
    if (!newName.trim()) return
    onCreate(newName.trim(), task.trim())
    setNewName('')
    setTask('')
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
          <input id="newname" autoFocus placeholder="name or NUM-1234" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input aria-label="Task for Claude (optional)" placeholder="task for Claude (optional)" value={task} onChange={(e) => setTask(e.target.value)} />
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
          const where = f.kind === 'session'
            ? `◷ ${f.path === repo ? 'main checkout' : f.path.slice(repo.length + 1)} · ⎇ ${f.branch || '?'}`
            : null
          return (
            <li key={f.name}>
              {heading && <div className="group" role="presentation">Sessions in the main checkout</div>}
              <button type="button" className={`row ${f.name === current ? 'current' : ''} ${st}`} aria-current={f.name === current ? 'page' : undefined}
                title={`${f.title} — ${STATE[st].word}${f.status.message ? `: ${f.status.message}` : ''}`}
                onClick={() => onPick(f.name)} onDoubleClick={() => setRenaming(f.name)}
                onContextMenu={(e) => { e.preventDefault(); onMenu(f) }}>
                <span className="glyph" style={{ color: `var(--${st === 'offline' ? 'text-3' : st})` }} aria-label={STATE[st].word}>{STATE[st].glyph}</span>
                <span className="text">
                  <div className="title">{f.title}</div>
                  <div className="sub">{where || `${f.parent ? `↳ ${f.parent} · ` : ''}⎇ ${f.branch.replace(/^[^/]+\//, '')}${prBit}`}</div>
                </span>
                {i < 9 && <span className="num" aria-hidden="true">⌘{i + 1}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="side-foot">⌘N new · ⌘E rename · ⌘1–9 switch</div>
    </nav>
  )
}

// ---------- header (design A) ----------
function Header({ f, pal, panels, openList, onToggle }) {
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
        <span className="next"><b>NEXT ▸</b>{next}</span>
      </div>
      <div className="hrow">
        <span className="recap">
          {f.status.work || <span>No recap yet — it appears after Claude’s first turn</span>}
          {f.status.work && f.status.now && <span> — {f.status.now}</span>}
        </span>
        <span className="grow" />
        <span className="facts">
          {pr ? <a role="link" tabIndex={0} onClick={() => hub.open(pr.url)} onKeyDown={(e) => e.key === 'Enter' && hub.open(pr.url)}>PR #{pr.number}</a> : <span>no PR</span>}
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
        <span className="track" aria-label={`Stage ${stage + 1} of 8: ${STAGES[stage]}`}>
          {STAGES.map((s, i) => (
            <span key={s}>
              {i > 0 && <span className="sep">─</span>}
              <span className={i === stage ? 'cur' : i < stage ? 'done' : ''}>{i === stage ? `${s} ${i + 1}/8` : s}</span>
            </span>
          ))}
          {d.stage?.note && <span className="done">   {d.stage.note}</span>}
        </span>
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

// ---------- app ----------
function App() {
  const [state, setState] = useState({ features: [], palette: {} })
  const [current, setCurrent] = useState(() => localStorage.getItem(`current:${hub.project}`) || '')
  const [hosted, setHosted] = useState({}) // name -> { pane: { session, hint } }
  const [openPanels, setOpenPanels] = useState(() => {
    try { return JSON.parse(localStorage.getItem('open') || '{}') } catch { return {} }
  })
  const [zoom, setZoom] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const [newOpen, setNewOpen] = useState(false)
  const [creating, setCreating] = useState(null)
  const [toast, setToast] = useState(null)
  const filterRef = useRef(null)

  useEffect(() => {
    hub.state(hub.project).then(setState)
    hub.onState(setState)
  }, [])
  const features = state.features
  // a feature created anywhere (Claude's new_feature tool, fh new, + New) gets the focus once
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

  const say = (text, isError = false) => {
    setToast({ text, isError })
    setTimeout(() => setToast(null), isError ? 9000 : 3500)
  }

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
    const r = await hub.fh(['rename', name, ...title.trim().split(/\s+/)])
    if (r.code) say(r.stderr || r.stdout, true)
  }
  const create = async (name, task) => {
    setNewOpen(false)
    setCreating(name)
    const r = await hub.fh(['new', name, ...(state.project ? ['--project', state.project] : []), ...(task ? ['-p', task] : [])])
    setCreating(null)
    if (r.code) return say((r.stderr || r.stdout).trim(), true)
    setCurrent(name.toLowerCase())
    say(r.stdout.trim())
  }
  const rowMenu = async (feat) => {
    const choice = await hub.rowMenu({ name: feat.name, prUrl: feat.pr?.url, links: feat.links })
    if (choice === 'rename') setRenaming(feat.name)
    if (choice === 'restart') {
      const r = await hub.fh(['restart', feat.name])
      say((r.stdout || r.stderr).trim(), Boolean(r.code))
    }
    if (choice?.startsWith('open:')) hub.open(choice.slice(5))
    if (choice === 'open-pr') hub.open(feat.pr.url)
    if (choice === 'reveal') hub.reveal(feat.path)
    if (choice === 'done' && (await hub.confirm(`Close ${feat.title}?`, 'Stops its servers and Claude session and removes it from the list. The worktree and branch are kept.'))) {
      const r = await hub.fh(['done', feat.name])
      say((r.stdout || r.stderr).trim(), Boolean(r.code))
      setHosted((h) => ({ ...h, [feat.name]: undefined }))
    }
  }

  // menu accelerators and ⌘1…9
  const latest = useRef({})
  latest.current = { f, features, toggle, open, zoom, sessionsNow: f ? hosted[f.name] : null }
  useEffect(() => {
    hub.onMenu(async (action) => {
      const { f, toggle, open, zoom } = latest.current
      if (action === 'new') setNewOpen(true)
      if (action === 'find') filterRef.current?.focus()
      if (action === 'rename' && f) setRenaming(f.name)
      if (action === 'restart' && f) {
        const r = await hub.fh(['restart', f.name])
        say((r.stdout || r.stderr).trim(), Boolean(r.code))
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
        newOpen={newOpen} setNewOpen={setNewOpen} onCreate={create} creating={creating} filterRef={filterRef} />
      <main className="main">
        {!f && (
          <div className="empty">
            {state.project ? (
              <>
                <h1>No features in {state.project} yet</h1>
                <p>Each feature gets a worktree, its own ports, services and a Claude session.</p>
                <button className="btn primary" type="button" onClick={() => setNewOpen(true)}>New feature  ⌘N</button>
              </>
            ) : (
              <>
                <h1>Add a project to begin</h1>
                <p>Choose the main checkout of a git repository. A .grove.json in it describes its services.</p>
                <button className="btn primary" type="button" onClick={() => hub.addProject()}>Add project  ⌘⇧O</button>
              </>
            )}
          </div>
        )}
        {f && (
          <>
            <Header f={f} pal={pal} panels={sessions ? Object.values(sessions).filter((s) => s.pane !== 'claude').map((s) => ({ name: s.pane, key: s.key })) : []} openList={open} onToggle={toggle} />
            <div className="work">
              <section className="claude" aria-label="Claude session">
                {sessions?.claude ? <TerminalView termKey={`${f.name}:claude`} session={sessions.claude.session} focus={!zoom} />
                  : <div className="empty"><p className="busy">Starting {f.title}…</p></div>}
              </section>
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
      {toast && <div className={`toast ${toast.isError ? 'error' : ''}`} role="status">{toast.text}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
