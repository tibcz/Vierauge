// Builds two single-file versions of the game from public/:
//   dist/Vierauge.html          full document, double-click to play offline
//   dist/vierauge-artifact.html page body for a claude.ai Artifact (no html/head/body tags)
// Run: npm run build
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const scripts = ['engine.js', 'game.js'].map(read);

for (const s of scripts) {
  if (/<\/script/i.test(s) || s.includes('<!--')) throw new Error('script would break when inlined');
}
const inlineScripts = scripts.map(s => '<script>\n' + s + '\n</script>').join('\n');

// The single file has no neighbours: its icon travels inside it, and the CSP (which
// forbids inline scripts) stays with the hosted version only.
const iconUri = 'data:image/svg+xml,' + encodeURIComponent(read('favicon.svg').trim());
const standalone = html
  .replace(/<!--CSP-->[\s\S]*?<!--\/CSP-->\n?/, '')
  .replace(/<link rel="icon"[^>]*>\n|<link rel="apple-touch-icon"[^>]*>\n|<link rel="canonical"[^>]*>\n/g, '')
  .replace('<link rel="stylesheet" href="styles.css">', () => '<link rel="icon" href="' + iconUri + '">\n<style>\n' + css + '\n</style>')
  .replace('<script src="engine.js"></script>\n<script src="game.js"></script>', () => inlineScripts);
if (standalone.includes('src="engine.js"') || standalone.includes('href="styles.css"')) throw new Error('standalone build left an external reference');

const body = html.slice(html.indexOf('<!--APP-->') + 10, html.indexOf('<!--/APP-->'));
const artifact = '<title>Vierauge</title>\n<style>\n' + css + '\n</style>\n' + body.trim() + '\n' + inlineScripts + '\n';

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'Vierauge.html'), standalone);
fs.writeFileSync(path.join(root, 'dist', 'vierauge-artifact.html'), artifact);
console.log('dist/Vierauge.html', (standalone.length / 1024).toFixed(1) + ' KB');
console.log('dist/vierauge-artifact.html', (artifact.length / 1024).toFixed(1) + ' KB');
