import fs from 'node:fs';

const files = [
  'edge-functions/index.js',
  'edge-functions/admin.js',
  'agent-edgeone/edge-functions/index.js',
  'agent-edgeone/edge-functions/admin.js'
];

for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  // Find start and end of pageHtml template literal
  const startMarker = 'function pageHtml() {\n  return `';
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    console.error('Marker not found in', f);
    process.exit(1);
  }
  const endIdx = content.lastIndexOf('`;\n}');
  const html = content.slice(startIdx + startMarker.length, endIdx);
  const scriptMatch = html.match(/<script[\s\S]*?<\/script>/i);
  if (!scriptMatch) {
    console.error('No script tag found in inlined html of', f);
    process.exit(1);
  }
  const rawJs = scriptMatch[0].replace(/<script[\s\S]*?>/i, '').replace(/<\/script>/i, '');
  // Unescape backticks and dollar signs that were escaped in template literal
  const unescapedJs = rawJs.replace(/\\`/g, '`').replace(/\\\${/g, '${').replace(/\\\\/g, '\\');
  try {
    new Function(unescapedJs);
    console.log(`PASS: ${f} inlined JS syntax valid`);
  } catch (err) {
    console.error(`FAIL: ${f} syntax error:`, err.message);
    process.exit(1);
  }
}
