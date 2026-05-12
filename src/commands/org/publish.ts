import type { Argv, ArgumentsCamelCase } from 'yargs';
import { marked } from 'marked';
import * as output from '../../lib/output';
import { pinJson } from '../../lib/ipfs';

interface PublishArgs {
  org: string;
  cid: string;
  title: string;
  description?: string;
  chain?: number;
  json?: boolean;
}

/**
 * Render markdown → HTML with Argus dark-theme styling matching the live
 * poa.box / Argus org pages (Home, Mission, Pride). Properly handles
 * headings, tables, lists (nested), links, code blocks, blockquotes,
 * inline code, bold/italic, horizontal rules.
 *
 * Hudson HB#1058 directive: prior renderer only handled `#`/`##` headings +
 * `**bold**` inline; tables/lists/code rendered as wall-of-text. This
 * upgrade makes ALL future research outputs cleanly shareable.
 */
function buildArgusHtml(markdownBody: string, title: string, description: string, sourceCid: string): string {
  // Configure marked for safe + GitHub-flavored markdown.
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  const renderedBody = marked.parse(markdownBody) as string;
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://ipfs.io/ipfs/${sourceCid}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">
<style>
:root {
  --bg: #0a0e1a;
  --panel: #11172a;
  --border: #1f2841;
  --text: #e8ecf5;
  --muted: #8b95b5;
  --accent: #5fa8ff;
  --accent-soft: #5fa8ff22;
  --good: #5fd9a8;
  --warn: #ffb86b;
  --mono: 'SF Mono', Menlo, Monaco, Consolas, 'Courier New', monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.7; -webkit-font-smoothing: antialiased; }
body { max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
header { margin-bottom: 3rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
header .brand { font-size: 0.85rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.5rem; }
header .brand a { color: var(--accent); text-decoration: none; }
header .brand a:hover { text-decoration: underline; }

article h1 { font-size: 2.1rem; line-height: 1.25; margin: 1.5rem 0 1rem; color: var(--text); font-weight: 700; }
article h2 { font-size: 1.5rem; line-height: 1.35; margin: 2.5rem 0 0.75rem; color: var(--text); font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
article h3 { font-size: 1.2rem; margin: 2rem 0 0.5rem; color: var(--text); font-weight: 600; }
article h4 { font-size: 1.05rem; margin: 1.5rem 0 0.4rem; color: var(--text); font-weight: 600; }
article p { margin: 0.9rem 0; color: var(--text); }
article p em, article em { color: var(--muted); font-style: italic; }
article strong { color: #fff; font-weight: 600; }
article a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.15s; }
article a:hover { border-bottom-color: var(--accent); }

article ul, article ol { margin: 0.9rem 0 0.9rem 1.5rem; padding-left: 0.5rem; }
article li { margin: 0.4rem 0; }
article li > p { margin: 0.2rem 0; }
article li ul, article li ol { margin-top: 0.3rem; margin-bottom: 0.3rem; }

article blockquote { margin: 1.2rem 0; padding: 0.6rem 1.2rem; border-left: 3px solid var(--accent); background: var(--accent-soft); color: var(--muted); }
article blockquote p { margin: 0.3rem 0; }

article hr { border: 0; border-top: 1px solid var(--border); margin: 2.5rem 0; }

article code { font-family: var(--mono); font-size: 0.9em; background: var(--panel); padding: 0.15em 0.4em; border-radius: 3px; color: var(--good); border: 1px solid var(--border); }
article pre { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 1rem 1.2rem; overflow-x: auto; margin: 1.2rem 0; }
article pre code { background: none; padding: 0; border: none; color: var(--text); font-size: 0.875em; line-height: 1.55; }

article table { width: 100%; border-collapse: collapse; margin: 1.2rem 0; font-size: 0.92em; }
article th { text-align: left; font-weight: 600; padding: 0.6rem 0.8rem; background: var(--panel); border: 1px solid var(--border); color: var(--text); }
article td { padding: 0.55rem 0.8rem; border: 1px solid var(--border); color: var(--text); vertical-align: top; }
article tr:nth-child(even) td { background: rgba(95, 168, 255, 0.04); }
article table code { font-size: 0.85em; }

footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--border); font-size: 0.85rem; color: var(--muted); }
footer a { color: var(--accent); text-decoration: none; }
footer a:hover { text-decoration: underline; }
footer .source { font-family: var(--mono); font-size: 0.78rem; word-break: break-all; margin-top: 0.4rem; }

@media (max-width: 600px) {
  body { padding: 1.5rem 1rem 3rem; }
  article h1 { font-size: 1.7rem; }
  article h2 { font-size: 1.3rem; }
  article table { display: block; overflow-x: auto; }
}

@media print {
  body { background: #fff; color: #000; max-width: none; }
  article h1, article h2, article h3, article strong { color: #000; }
  article a { color: #0033cc; }
  article code, article pre { background: #f0f0f0; border-color: #ccc; color: #000; }
  article table th, article table td { border-color: #999; }
  header, footer { border-color: #999; }
  footer { color: #555; }
}
</style>
</head>
<body>
<header>
<div class="brand"><a href="https://poa.box">Argus</a> — autonomous DAO governance research</div>
</header>
<article>
${renderedBody}
</article>
<footer>
<p>Authored autonomously by the <a href="https://poa.box">Argus</a> 3-agent governance fleet. Published to IPFS as immutable content.</p>
<p class="source"><strong>Source CID:</strong> ${escapeHtml(sourceCid)}</p>
</footer>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const publishHandler = {
  builder: (yargs: Argv) => yargs
    .option('cid', { type: 'string', demandOption: true, describe: 'IPFS CID of content to publish (markdown, JSON, or HTML)' })
    .option('title', { type: 'string', demandOption: true, describe: 'Page title (used for <title> + OG/Twitter cards)' })
    .option('description', { type: 'string', default: '', describe: 'Page description for social-share preview cards' }),

  handler: async (argv: ArgumentsCamelCase<PublishArgs>) => {
    const spin = output.spinner('Creating shareable page...');
    spin.start();

    try {
      const contentCid = argv.cid as string;
      const title = argv.title as string;
      const desc = (argv.description as string) || title;

      spin.text = 'Fetching content from IPFS...';
      const response = await fetch(`https://ipfs.io/ipfs/${contentCid}`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        throw new Error(`Failed to fetch CID ${contentCid}: HTTP ${response.status}`);
      }
      const raw = await response.text();

      // Detect format. Markdown is the canonical input; JSON (with .content
      // or .body field) and pre-rendered HTML are accepted fallbacks.
      let markdownBody: string;
      let alreadyHtml = false;
      const trimmed = raw.trimStart();

      if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        // Already HTML — inject OG/Twitter tags into <head>, otherwise leave
        // the body untouched. This preserves manually-styled pages.
        alreadyHtml = true;
        const safeTitle = escapeHtml(title);
        const safeDesc = escapeHtml(desc);
        const ogBlock = `<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://ipfs.io/ipfs/${contentCid}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDesc}">`;
        const wrapped = raw.includes('<head>')
          ? raw.replace('<head>', `<head>\n${ogBlock}`)
          : raw;
        spin.text = 'Pinning page...';
        const cid = await pinJson(wrapped);
        spin.stop();
        const result = { cid, url: `https://ipfs.io/ipfs/${cid}`, title, description: desc, source: contentCid, mode: 'pre-rendered-html' };
        if (argv.json) console.log(JSON.stringify(result));
        else output.success('Published', result);
        return;
      } else {
        try {
          const json = JSON.parse(raw);
          markdownBody = json.content || json.body || JSON.stringify(json, null, 2);
        } catch {
          markdownBody = raw;
        }
      }

      spin.text = 'Rendering markdown → HTML...';
      const html = buildArgusHtml(markdownBody, title, desc, contentCid);

      spin.text = 'Pinning HTML page...';
      const cid = await pinJson(html);

      spin.stop();
      const result = {
        cid,
        url: `https://ipfs.io/ipfs/${cid}`,
        title,
        description: desc,
        source: contentCid,
        mode: alreadyHtml ? 'pre-rendered-html' : 'markdown-rendered',
        renderer: 'marked v18 + Argus dark theme',
      };
      if (argv.json) console.log(JSON.stringify(result));
      else output.success('Published', result);
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
