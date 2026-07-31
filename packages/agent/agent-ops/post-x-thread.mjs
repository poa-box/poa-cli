#!/usr/bin/env node
/**
 * post-x-thread.mjs — implementation backing for the .claude/skills/post-thread
 * skill, task #377 HB#436.
 *
 * WHAT IT DOES:
 *   - Parses a thread input file. Two formats supported:
 *       (a) Markdown distribution files with **N/** blocks (our standard
 *           format in reports/distribution/*-twitter.md)
 *       (b) JSON files of shape { tweets: [...] } (the pre-existing skill
 *           spec format, kept for backwards compatibility with any earlier
 *           stored drafts)
 *   - Validates each tweet ≤ 280 chars, thread ≥ 2 tweets, no obvious
 *     placeholders
 *   - DRY-RUN by default: prints what it would post, one tweet per line,
 *     with a char count. No network calls.
 *   - When --post is passed AND POP_X_TOKEN is set in env OR read from
 *     ~/.pop-agent/x-token.txt, calls the X API v2 (POST /2/tweets) with
 *     reply_to chaining. On success, appends to reports/distribution/post-history.md
 *     with timestamp, source path, thread root URL, first tweet id.
 *
 * WHAT IT INTENTIONALLY DOES NOT DO:
 *   - Does NOT post without --post. --post is the explicit opt-in. Dry-run
 *     is the safe default because accidental posts are high-blast-radius.
 *   - Does NOT handle the initial token acquisition. Hudson creates the
 *     token via the X developer console and drops it in ~/.pop-agent/x-token.txt
 *     (600 perms) OR exports POP_X_TOKEN. First-time setup is still his.
 *   - Does NOT watch for reply engagement after posting — that's a
 *     separate follow-up task since it requires a long-running process or
 *     a scheduled re-query.
 *   - Does NOT rate-limit across invocations. A 9-tweet thread fits the
 *     X free tier with room to spare, and the script rejects if --post is
 *     called more than once per ~60 minutes by reading post-history.md.
 *
 * USAGE:
 *   node agent/scripts/post-x-thread.mjs <path>                 # dry-run
 *   node agent/scripts/post-x-thread.mjs <path> --post          # real post
 *   node agent/scripts/post-x-thread.mjs <path> --post --force  # bypass the
 *                                                               # 60-min rate limit
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const MAX_TWEET = 280;
const RATE_LIMIT_MIN_SEC = 3600; // 60 min between --post runs unless --force
const POST_HISTORY = resolve('reports/distribution/post-history.md');

// --- arg parse ---
const argv = process.argv.slice(2);
let inputPath = null;
const flags = new Set();
for (const a of argv) {
  if (a.startsWith('--')) flags.add(a.slice(2));
  else if (!inputPath) inputPath = a;
}
if (!inputPath) {
  console.error('Usage: node agent/scripts/post-x-thread.mjs <path> [--post] [--force]');
  console.error('  Default is dry-run. Add --post to actually hit the X API.');
  process.exit(1);
}

const isPost = flags.has('post');
const isForce = flags.has('force');

// --- parse input ---
const src = readFileSync(inputPath, 'utf8');
let tweets;

if (inputPath.endsWith('.json')) {
  const obj = JSON.parse(src);
  tweets = obj.tweets || [];
  if (!Array.isArray(tweets) || tweets.length < 2) {
    console.error(`✗ JSON input must have a 'tweets' array with at least 2 entries`);
    process.exit(1);
  }
} else if (inputPath.endsWith('.md')) {
  // Markdown parser: **N/** blocks.
  // Split by horizontal rules, find blocks starting with **N/** where N is
  // a 1-2 digit number. Extract the block content up to the next *** or ---
  // or end of file. Strip leading **N/** header and trailing sender-notes.
  const lines = src.split('\n');
  tweets = [];
  let current = null;
  let currentIdx = null;
  const flush = () => {
    if (current != null) {
      const cleaned = current.trim();
      if (cleaned) tweets.push({ idx: currentIdx, text: cleaned });
    }
    current = null;
    currentIdx = null;
  };
  for (const ln of lines) {
    const headerMatch = ln.match(/^\*\*(\d+)\/\*\*\s*$/);
    if (headerMatch) {
      flush();
      currentIdx = parseInt(headerMatch[1], 10);
      current = '';
      continue;
    }
    if (ln.startsWith('---')) {
      flush();
      continue;
    }
    if (ln.startsWith('## ')) {
      // section break (e.g. "Sender notes") — stop parsing tweets
      flush();
      break;
    }
    if (current != null) {
      current += (current ? '\n' : '') + ln;
    }
  }
  flush();
  if (tweets.length < 2) {
    console.error(`✗ Markdown input parsed to fewer than 2 tweets. Expected **N/** blocks separated by ---.`);
    console.error(`  Found ${tweets.length} block(s).`);
    process.exit(1);
  }
  // Normalize to text-only array for the posting loop, but keep idx for
  // logging sanity checks.
  const gaps = [];
  for (let i = 0; i < tweets.length; i++) {
    if (tweets[i].idx !== i + 1) gaps.push(`block[${i}] idx=${tweets[i].idx} expected ${i + 1}`);
  }
  if (gaps.length) {
    console.error(`✗ Thread numbering gap detected: ${gaps.join('; ')}`);
    process.exit(1);
  }
  tweets = tweets.map(t => t.text);
} else {
  console.error(`✗ Unsupported input format: ${inputPath} (expected .md or .json)`);
  process.exit(1);
}

// --- validate ---
const problems = [];
tweets.forEach((t, i) => {
  const n = i + 1;
  if (t.length > MAX_TWEET) problems.push(`tweet ${n}: ${t.length} chars (max ${MAX_TWEET})`);
  if (t.includes('TODO') || t.includes('FIXME') || t.includes('{{')) {
    problems.push(`tweet ${n}: contains placeholder text`);
  }
});
if (problems.length) {
  console.error(`✗ Validation failed:`);
  problems.forEach(p => console.error(`  - ${p}`));
  process.exit(1);
}

// --- rate-limit check (before posting) ---
if (isPost && !isForce && existsSync(POST_HISTORY)) {
  const history = readFileSync(POST_HISTORY, 'utf8');
  const lastTimestampMatch = history.match(/\| (\d{4}-\d{2}-\d{2}T[\d:.Z-]+) \|/g);
  if (lastTimestampMatch && lastTimestampMatch.length > 0) {
    const last = lastTimestampMatch[lastTimestampMatch.length - 1].match(/(\d{4}-\d{2}-\d{2}T[\d:.Z-]+)/)[1];
    const lastMs = Date.parse(last);
    const sinceSec = (Date.now() - lastMs) / 1000;
    if (sinceSec < RATE_LIMIT_MIN_SEC) {
      const waitMin = Math.ceil((RATE_LIMIT_MIN_SEC - sinceSec) / 60);
      console.error(`✗ Rate limit: last post was ${Math.floor(sinceSec / 60)}m ago, min interval is ${RATE_LIMIT_MIN_SEC / 60}m.`);
      console.error(`  Wait ${waitMin} more minute(s) OR pass --force to bypass.`);
      process.exit(1);
    }
  }
}

// --- dry-run output ---
console.log(`\n📋 Thread parsed from ${inputPath}`);
console.log(`   ${tweets.length} tweets, ${tweets.reduce((a, t) => a + t.length, 0)} total chars`);
console.log();
tweets.forEach((t, i) => {
  const n = i + 1;
  const charLabel = `[${t.length}/${MAX_TWEET}]`;
  console.log(`--- tweet ${n}/${tweets.length} ${charLabel} ---`);
  console.log(t);
  console.log();
});

if (!isPost) {
  console.log(`✓ Dry-run complete. Pass --post to actually hit the X API.`);
  console.log(`  (Real posting requires POP_X_TOKEN env OR ~/.pop-agent/x-token.txt)`);
  process.exit(0);
}

// --- real post path ---
let bearerToken = process.env.POP_X_TOKEN;
if (!bearerToken) {
  const tokenPath = join(homedir(), '.pop-agent', 'x-token.txt');
  if (existsSync(tokenPath)) {
    bearerToken = readFileSync(tokenPath, 'utf8').trim();
  }
}
if (!bearerToken) {
  console.error(`✗ --post requires POP_X_TOKEN env var or ~/.pop-agent/x-token.txt`);
  console.error(`  Obtain an X API v2 bearer token with tweet.write scope and drop it in either location.`);
  process.exit(1);
}

console.log(`\n🚀 Posting thread to X via API v2...`);
const postedIds = [];
let previousId = null;
for (let i = 0; i < tweets.length; i++) {
  const n = i + 1;
  const body = { text: tweets[i] };
  if (previousId) body.reply = { in_reply_to_tweet_id: previousId };

  try {
    const res = await fetch('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`✗ tweet ${n}/${tweets.length} failed: HTTP ${res.status} ${text}`);
      console.error(`  Already posted: ${postedIds.join(', ')}`);
      process.exit(1);
    }
    const data = await res.json();
    const id = data?.data?.id;
    if (!id) {
      console.error(`✗ tweet ${n}/${tweets.length} returned unexpected response: ${JSON.stringify(data)}`);
      process.exit(1);
    }
    postedIds.push(id);
    previousId = id;
    console.log(`  ✓ tweet ${n}/${tweets.length} posted: ${id}`);
    // inter-tweet delay to stay under per-second rate limit
    if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 1100));
  } catch (err) {
    console.error(`✗ tweet ${n}/${tweets.length} errored: ${err.message}`);
    console.error(`  Already posted: ${postedIds.join(', ')}`);
    process.exit(1);
  }
}

const rootUrl = `https://x.com/ClawDAOBot/status/${postedIds[0]}`;
console.log(`\n🎉 Thread posted: ${rootUrl}`);
console.log(`   First tweet id: ${postedIds[0]}`);
console.log(`   Total tweets: ${postedIds.length}`);

// --- log to post-history.md ---
const now = new Date().toISOString();
const historyExists = existsSync(POST_HISTORY);
const header = `# Argus Distribution Post History

Auto-appended by \`agent/scripts/post-x-thread.mjs\`. Rate-limit guard reads
the most recent timestamp and refuses another --post within 60 min unless
--force is passed.

| Date | Source | Tweets | First ID | Thread URL |
|---|---|---|---|---|
`;
const row = `| ${now} | ${basename(inputPath)} | ${postedIds.length} | ${postedIds[0]} | ${rootUrl} |\n`;
if (historyExists) {
  const existing = readFileSync(POST_HISTORY, 'utf8');
  writeFileSync(POST_HISTORY, existing + row);
} else {
  writeFileSync(POST_HISTORY, header + row);
}
console.log(`   Logged to ${POST_HISTORY}`);
