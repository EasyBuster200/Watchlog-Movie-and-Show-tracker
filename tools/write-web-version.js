// Writes public/version.json for the web deploy (Cloudflare's build command runs
// `node tools/write-web-version.js`), so Settings can show which build is live. Same numbering
// as the Android app (android/app/build.gradle): versionName is 2.<commit count>.
//
// Build machines often clone only the latest commit, which makes the count wrong, so a shallow
// clone is deepened first; if that fails the version is left out and only the commit is shown.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function commitCount() {
  try {
    if (git('rev-parse --is-shallow-repository') === 'true') git('fetch --unshallow --quiet');
    return Number(git('rev-list --count HEAD'));
  } catch (error) {
    return null;
  }
}

// The build checks out the commit being deployed, so git knows its id. Cloudflare's own
// environment variables are only a fallback, and only when they hold a real commit id (a
// Workers build's variable turned out to hold the branch name).
const isCommitId = value => /^[0-9a-f]{7,40}$/i.test(value || '');
let commit = null;
try {
  commit = git('rev-parse HEAD');
} catch (error) {
  commit = [process.env.WORKERS_CI_COMMIT_SHA, process.env.CF_PAGES_COMMIT_SHA].find(isCommitId) || null;
}

const count = commitCount();
const info = {
  versionName: count ? `2.${count}` : null,
  commit: commit ? commit.slice(0, 7) : null,
  builtAt: new Date().toISOString(),
};

const out = path.join(__dirname, '..', 'public', 'version.json');
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), out)}:`, info);
