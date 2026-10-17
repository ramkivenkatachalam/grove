// Records the commit the app is built from, so `grove update` can tell when the installed app is behind
// and About Grove can say which build is running. main.js calls buildInfo() itself when run from source.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function buildInfo() {
  const git = (...args) => execFileSync('git', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  const subject = git('log', '-1', '--format=%s')
  let repo = ''
  try {
    repo = git('remote', 'get-url', 'origin').replace(/\/\/[^/@]*@/, '//').replace(/\.git$/, '') // never a token from an https URL
    // an ssh remote (git@github.com:o/r.git, or a host alias like github-work:o/r) reads better as its web page
    const ssh = repo.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]*github[^:/]*)[:/](.+?)(?:\.git)?$/)
    if (ssh) repo = `https://github.com/${ssh[2]}`
  } catch {}
  return {
    commit: git('rev-parse', 'HEAD'),
    short: git('rev-parse', '--short', 'HEAD'),
    pr: subject.match(/\(#(\d+)\)$/)?.[1] || null, // squash merges end in "(#18)"
    subject,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    repo,
    builtAt: new Date().toISOString(),
  }
}

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, '..', 'version.json'), JSON.stringify(buildInfo()) + '\n')
}
module.exports = { buildInfo }
