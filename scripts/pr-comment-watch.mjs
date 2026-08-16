#!/usr/bin/env node
// Watch open PRs on the private repo for comments we have not seen yet.
//
// WHY THIS EXISTS AND NOT A GITHUB SUBSCRIPTION: GitHub's own notifications
// arrive as mail from notifications@github.com, and the email-triage heartbeat
// classifies exactly that sender as deterministic noise. Subscribing would look
// like coverage and deliver nothing. This polls the API instead.
//
// Silent when there is nothing new. Loud when it cannot look: a failed `gh`
// call exits non-zero and says so, because "no new comments" and "I could not
// check" must never print the same.
//
// State: store/.pr-comment-watch.json — { "<repo>#<pr>": lastCommentId }

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.env.PR_WATCH_REPO ?? 'iszzu80-dev/marveen-private'
const ROOT = process.env.MARVEEN_REPO_ROOT ?? '/home/iszzu/marveen'
const STATE = join(ROOT, 'store', '.pr-comment-watch.json')
const TOKEN_FILE = join(ROOT, 'store', '.dashboard-token')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
}

// My own comments must not wake me. `user.login` cannot do this: every session
// on this box posts through the SAME GitHub account (iszzu80-dev), so the peer
// reviewer and I are indistinguishable by author — the same missing-sender
// -authentication shape the message bus has.
//
// So the marker is a self-declared heading, and it is worth being honest about
// what that buys: it suppresses MY comments because I write them, and it would
// suppress a peer's comment that happened to open the same way. That is the
// right way round — a missed wake-up costs one polling cycle, a false wake-up
// costs a wrong reply.
const OWN_MARKER = /^##\s*Marveen\b/m

function isOwnComment(c) {
  return OWN_MARKER.test(c.body ?? '')
}

function loadState() {
  if (!existsSync(STATE)) return {}
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return {} }
}

let prs
try {
  prs = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--json', 'number,title,url']))
} catch (err) {
  console.error(`pr-comment-watch: cannot list PRs on ${REPO}: ${err.message}`)
  process.exit(1)
}

const state = loadState()
const fresh = []

for (const pr of prs) {
  const key = `${REPO}#${pr.number}`
  let comments
  try {
    comments = JSON.parse(gh([
      'api', `repos/${REPO}/issues/${pr.number}/comments`,
      '--paginate', '--jq', '[.[] | {id, user: .user.login, created_at, body}]',
    ]))
  } catch (err) {
    console.error(`pr-comment-watch: cannot read comments on ${key}: ${err.message}`)
    process.exit(1)
  }
  if (!comments.length) { state[key] ??= 0; continue }
  const lastSeen = state[key] ?? 0
  const unseen = comments.filter(c => c.id > lastSeen && !isOwnComment(c))
  // First sight of a PR is not a backlog dump: record the tip, report nothing.
  if (lastSeen === 0) { state[key] = comments[comments.length - 1].id; continue }
  if (unseen.length) {
    fresh.push({ pr, unseen })
    state[key] = unseen[unseen.length - 1].id
  }
}

writeFileSync(STATE, JSON.stringify(state, null, 1))

if (!fresh.length) process.exit(0)

const lines = fresh.map(({ pr, unseen }) => {
  const who = [...new Set(unseen.map(c => c.user))].join(', ')
  const head = unseen[unseen.length - 1].body.split('\n').find(l => l.trim()) ?? ''
  return `PR #${pr.number} (${pr.title}): ${unseen.length} uj komment ${who}-tol. Legutobbi kezdete: ${head.slice(0, 180)}. ${pr.url}`
})

const content = `[PR-FIGYELO] Uj komment(ek) erkeztek, amikre valaszolni kell:\n${lines.join('\n')}`

try {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  execFileSync('curl', [
    '-s', '-X', 'POST', 'http://localhost:3420/api/messages',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${token}`,
    '--data-binary', JSON.stringify({ from: 'marveen', to: 'marveen', content, origin_note: 'pr-comment-watch' }),
  ], { encoding: 'utf8', timeout: 30_000 })
} catch (err) {
  console.error(`pr-comment-watch: found ${fresh.length} PR(s) with new comments but could not post to the bus: ${err.message}`)
  process.exit(1)
}

console.log(JSON.stringify({ repo: REPO, prsWithNewComments: fresh.map(f => f.pr.number) }))
