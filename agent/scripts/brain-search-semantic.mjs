#!/usr/bin/env node
/**
 * agent/scripts/brain-search-semantic.mjs — task #566 (argus HB#854 closure)
 *
 * Semantic search over pop.brain.shared lessons (or any brain doc) to close
 * the brain-search asymmetry surfaced HB#854. Two empirical miss cases this
 * tool must surface in top-K results:
 *   (A) HB#1074 parallel-draft: vigil HB#721 + sentinel HB#1070 both drafted
 *       Part XI under different filenames; neither found the other.
 *   (B) HB#852/#1065 CLever Safe: argus rediscovered same Safe sentinel had
 *       already found 50 HB-arcs earlier under a different title.
 *
 * v0.1 ships TF-IDF + cosine similarity with NO external ML dependencies —
 * validates the use case + handles both empirical miss cases (which are
 * keyword-recoverable from body text). v0.2 (separate future task) can
 * upgrade to embedding-based semantic search via Transformers.js for true
 * paraphrase robustness.
 *
 * Usage:
 *   node agent/scripts/brain-search-semantic.mjs --query "<query>" \
 *     [--doc pop.brain.shared] [--top-k 5] [--json]
 *
 * Acceptance per #74 spec:
 *   --query "CLever Safe" → surfaces sentinel HB#1065 in top-5
 *
 * Exit codes:
 *   0 — query returned results
 *   2 — no results above threshold (silent-failure prevention)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOOLING_VERSION = 'brain-search-semantic-v0.1-tfidf';
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const POP_CLI = path.join(REPO_ROOT, 'dist', 'index.js');

// Argv parsing (lightweight; matches survey-tools.mjs pattern)
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  return argv[i + 1];
}
const QUERY = flag('--query', null);
const DOC_ID = flag('--doc', 'pop.brain.shared');
const TOP_K = Number(flag('--top-k', 5));
const MIN_SCORE = Number(flag('--min-score', 0.05));
const JSON_OUTPUT = argv.includes('--json');

if (!QUERY) {
  console.error(`Usage: node ${path.basename(import.meta.url)} --query "<query>" [--doc pop.brain.shared] [--top-k 5] [--min-score 0.05] [--json]`);
  process.exit(1);
}

// Tokenize: lowercase, alphanumeric, drop stop words, length >= 2
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with', 'i', 'we', 'you', 'they', 'my', 'our', 'your', 'their',
  'have', 'had', 'been', 'being', 'do', 'does', 'did', 'but', 'if', 'so', 'no',
  'not', 'all', 'any', 'some', 'more', 'most', 'such', 'than', 'then', 'when',
  'how', 'why', 'where', 'who', 'what', 'which', 'these', 'those', 'each', 'one',
  'two', 'also', 'too', 'just', 'only', 'now', 'still', 'over', 'up', 'down',
  'out', 'off', 'about', 'after', 'before', 'between', 'into', 'through', 'while',
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// Fetch brain doc + extract lessons
function fetchLessons(docId) {
  console.error(`[brain-search-semantic] fetching doc ${docId}...`);
  const raw = execFileSync('node', [POP_CLI, 'brain', 'read', '--doc', docId, '--json'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, // 256MB — brain.shared is ~3MB but allow headroom
  });
  // Output may have trailing newlines and CLI prefix; locate JSON object.
  const lines = raw.trim().split('\n');
  const jsonLine = lines[lines.length - 1];
  const parsed = JSON.parse(jsonLine);
  const lessons = parsed?.doc?.lessons ?? [];
  console.error(`[brain-search-semantic] loaded ${lessons.length} lessons`);
  return lessons;
}

// Build IDF map across the lesson corpus
function buildIdf(lessons, fieldExtractor) {
  const N = lessons.length;
  const df = new Map();
  for (const lesson of lessons) {
    const tokens = new Set(tokenize(fieldExtractor(lesson)));
    for (const tok of tokens) {
      df.set(tok, (df.get(tok) ?? 0) + 1);
    }
  }
  const idf = new Map();
  for (const [tok, freq] of df.entries()) {
    // Smoothed IDF: log((N + 1) / (df + 1)) + 1
    idf.set(tok, Math.log((N + 1) / (freq + 1)) + 1);
  }
  return idf;
}

// TF-IDF vector for a token list (normalized to unit length)
function tfidfVector(tokens, idf) {
  const tf = new Map();
  for (const tok of tokens) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }
  const vec = new Map();
  let norm = 0;
  for (const [tok, freq] of tf.entries()) {
    const idfVal = idf.get(tok);
    if (!idfVal) continue; // token unseen in corpus — drop
    const tfidf = freq * idfVal;
    vec.set(tok, tfidf);
    norm += tfidf * tfidf;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const [tok, val] of vec.entries()) {
      vec.set(tok, val / norm);
    }
  }
  return vec;
}

// Cosine similarity between two normalized TF-IDF vectors
function cosine(v1, v2) {
  let dot = 0;
  // Iterate the smaller vector for efficiency
  const [smaller, larger] = v1.size < v2.size ? [v1, v2] : [v2, v1];
  for (const [tok, val] of smaller.entries()) {
    const other = larger.get(tok);
    if (other) dot += val * other;
  }
  return dot; // Both unit-normalized → cosine = dot product
}

// Field-weighted document text: title weight 3x, tags 2x, body 1x.
// This biases retrieval toward title/tag matches while allowing body context
// to surface lessons where the key concept is in the body but not the title.
function lessonText(lesson) {
  const title = lesson.title ?? '';
  const body = lesson.body ?? '';
  const tags = Array.isArray(lesson.tags) ? lesson.tags.join(' ') : '';
  return `${title} ${title} ${title} ${tags} ${tags} ${body}`;
}

// Main
const lessons = fetchLessons(DOC_ID);
const idf = buildIdf(lessons, lessonText);

const queryTokens = tokenize(QUERY);
const queryVec = tfidfVector(queryTokens, idf);

const scored = [];
for (const lesson of lessons) {
  const docTokens = tokenize(lessonText(lesson));
  const docVec = tfidfVector(docTokens, idf);
  const score = cosine(queryVec, docVec);
  if (score >= MIN_SCORE) {
    scored.push({ lesson, score });
  }
}
scored.sort((a, b) => b.score - a.score);
const top = scored.slice(0, TOP_K);

const results = top.map(({ lesson, score }) => ({
  id: lesson.id,
  title: lesson.title,
  author: lesson.author,
  score: Math.round(score * 10000) / 10000,
  ts: lesson.ts,
  snippet: (lesson.body ?? '').slice(0, 220).replace(/\s+/g, ' '),
}));

if (JSON_OUTPUT) {
  console.log(JSON.stringify({
    tool: TOOLING_VERSION,
    doc: DOC_ID,
    query: QUERY,
    topK: TOP_K,
    minScore: MIN_SCORE,
    totalLessons: lessons.length,
    matched: scored.length,
    results,
  }, null, 2));
} else {
  console.log(`\n${TOOLING_VERSION} — doc:${DOC_ID} query:"${QUERY}" topK:${TOP_K}`);
  console.log(`Indexed: ${lessons.length} lessons; matched (>=${MIN_SCORE}): ${scored.length}\n`);
  if (results.length === 0) {
    console.log('(no results — try lowering --min-score or broader query)');
  } else {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const auth = r.author?.slice(0, 10) ?? '?';
      console.log(`${i + 1}. [score:${r.score.toFixed(3)}] [${auth}] ${r.title?.slice(0, 100)}`);
      console.log(`   id: ${r.id}`);
      console.log(`   snippet: ${r.snippet.slice(0, 160)}...\n`);
    }
  }
}

process.exit(scored.length > 0 ? 0 : 2);
