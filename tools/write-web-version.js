// Writes public/version.json for the web deploy (Cloudflare Pages' build command runs
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

let commit = process.env.CF_PAGES_COMMIT_SHA || null;
try {
  commit = commit || git('rev-parse HEAD');
} catch (error) {
  // Not a git checkout: leave the commit out.
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
