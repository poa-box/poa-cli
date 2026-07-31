---
name: post-thread
description: >
  Post a prepared X/Twitter thread from a markdown distribution file or JSON.
  Use when the user says "post the thread", "tweet this", "share on X", or
  when distribution of governance findings is needed. Implementation is
  packages/agent/scripts/post-x-thread.mjs. Dry-run is the safe default; --post is
  the explicit opt-in to hit the API.
---

# Post Thread Skill

Post a multi-tweet thread on X/Twitter from a prepared distribution file.

**Implementation**: `packages/agent/scripts/post-x-thread.mjs` (task #377, HB#436).
The script parses either (a) our standard `reports/distribution/*-twitter.md`
markdown files with `**N/**` blocks separated by `---`, or (b) legacy JSON
files of shape `{ tweets: [...] }`. It validates each tweet ≤ 280 chars,
enforces a 60-minute rate limit by reading `reports/distribution/post-history.md`,
and defaults to dry-run.

## Prerequisites

Bearer token in either:
```bash
export POP_X_TOKEN=<bearer token>
```
OR a file at `~/.pop-agent/x-token.txt` (600 perms).

The token is only needed for `--post`. Dry-run (the default) does not
require any credential. Hudson creates the token once via the X developer
console and drops it; subsequent posts from any agent with that file
reachable are self-serve.

## Usage

```bash
# Dry-run: parses, validates, prints what it would post. No network.
node packages/agent/scripts/post-x-thread.mjs reports/distribution/single-whale-capture-twitter.md

# Real post: add --post. Requires token. Rate-limited to 1 per 60 min.
node packages/agent/scripts/post-x-thread.mjs reports/distribution/single-whale-capture-twitter.md --post

# Bypass the 60-min rate limit (use sparingly, only for intentional back-to-back posts):
node packages/agent/scripts/post-x-thread.mjs <path> --post --force
```

## Input format — markdown (preferred)

Our standard distribution drafts live in `reports/distribution/*-twitter.md`
with this shape:

```
**1/**
First tweet text, any length up to 280 chars, can span multiple lines.

---

**2/**
Second tweet. Numbered sequentially with no gaps.
```

The parser stops at the first `## ` section header (e.g., "Sender notes"),
so anything after the tweets is metadata, not content. Numbering gaps are
a hard error — if `**3/**` is missing between `**2/**` and `**4/**`, the
validator refuses the post.

## Input format — JSON (legacy)

Backwards-compatible with the pre-HB#436 SKILL.md spec:

```json
{
  "tweets": [
    "1/ First tweet text...",
    "2/ Second tweet text..."
  ]
}
```

## Step 2: Validate

Before posting:
- Each tweet ≤ 280 characters
- Thread has at least 2 tweets
- No broken links or placeholder text
- API credentials are set

## Step 3: Post Thread

```javascript
// Pattern for posting a thread:
// 1. Post first tweet → get tweet_id
// 2. Post each subsequent tweet as reply to previous tweet_id
// 3. Log all tweet_ids for reference

for (const [i, text] of tweets.entries()) {
  const params = { text };
  if (i > 0) {
    params.reply = { in_reply_to_tweet_id: previousTweetId };
  }
  const result = await postTweet(params);
  previousTweetId = result.id;
  tweetIds.push(result.id);

  // Rate limit: wait 1 second between tweets
  await sleep(1000);
}
```

## Step 4: Log Results

After posting:
- Log all tweet IDs to heartbeat-log
- Record the thread URL (first tweet URL)
- Update shared.md with "Thread posted: [URL]"
- Create a task to track engagement (likes, retweets, replies)

## Available Threads

| Thread | IPFS | Tweets | Topic |
|--------|------|--------|-------|
| State of DAO Governance | QmPrGE... | 12 | 17 DAO audits findings |

## When API Not Available

If credentials aren't set:
- Output the thread as formatted text for manual posting
- Each tweet separated by `---`
- Include character count per tweet
- Ready to copy-paste

## Rate Limits

- X API v2 free tier: 1,500 tweets/month, 50 tweets/day
- Rate limit: max 1 tweet per second
- Thread of 12 tweets uses ~1% of daily limit
- If rate limited: wait, retry with exponential backoff
