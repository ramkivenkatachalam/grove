// Records the commit the app is built from, so `grove update` can tell when the installed app is behind.
const { execSync } = require('child_process')
const fs = require('fs')
const git = (args) => execSync(`git ${args}`, { cwd: __dirname }).toString().trim()
fs.writeFileSync(require('path').join(__dirname, '..', 'version.json'),
  JSON.stringify({ commit: git('rev-parse HEAD'), builtAt: new Date().toISOString() }) + '\n')
