#!/usr/bin/env node
/**
 * build-admin.mjs — Single-Source-of-Truth Build Pipeline for OCRProxy Admin UI
 *
 * Compiles modular admin sources from shared/admin/ into:
 *   1. EdgeOne self-contained edge functions:
 *      - agent-edgeone/edge-functions/index.js (GET /)
 *      - agent-edgeone/edge-functions/admin.js (GET /admin)
 *      - Synced to root edge-functions/
 *   2. Auto-generated standalone artifacts in agent-edgeone/ (admin.html, admin.css, admin.js)
 *   3. Automatically synced modular assets into vm-app/static/
 *
 * Usage: node agent-edgeone/scripts/build-admin.mjs
 */
import { readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const edgeoneDir = join(__dirname, '..');
const projectRoot = join(edgeoneDir, '..');
const sharedRoot = join(projectRoot, 'shared', 'admin');

console.log('=== OCRProxy Admin Build Pipeline: Single Source of Truth ===');

if (!existsSync(sharedRoot)) {
  console.error(`FATAL: Shared admin source directory not found at: ${sharedRoot}`);
  process.exit(1);
}

const sharedHtmlPath = join(sharedRoot, 'admin.html');
const sharedCssPath = join(sharedRoot, 'admin.css');
const sharedJsDir = join(sharedRoot, 'js');

if (!existsSync(sharedHtmlPath) || !existsSync(sharedCssPath) || !existsSync(sharedJsDir)) {
  console.error('FATAL: Incomplete shared/admin sources (admin.html, admin.css, or js/ missing)');
  process.exit(1);
}

// 1. Synchronize shared/admin to vm-app/static
const vmStaticDir = join(projectRoot, 'vm-app', 'static');
if (existsSync(vmStaticDir)) {
  cpSync(sharedHtmlPath, join(vmStaticDir, 'admin.html'));
  cpSync(sharedCssPath, join(vmStaticDir, 'admin.css'));
  cpSync(sharedJsDir, join(vmStaticDir, 'js'), { recursive: true });
  console.log(`[Sync] Synced shared/admin to vm-app/static: ${vmStaticDir}`);
}

// 2. Read single source HTML and CSS
const html = readFileSync(sharedHtmlPath, 'utf8');
const css = readFileSync(sharedCssPath, 'utf8');

// 3. Assemble JS bundle from modular shared/admin/js in strict dependency order
const JS_MODULES = [
  'core.js',
  'vault.js',
  'providers.js',
  'agent-models-ui.js',
  'models.js',
  'settings.js',
  'app.js',
];

let bundledJs = 'window.__ENV_TARGET__ = "edgeone";\n\n';
for (const mod of JS_MODULES) {
  const modPath = join(sharedJsDir, mod);
  if (!existsSync(modPath)) {
    console.error(`FATAL: Required JS module missing: ${modPath}`);
    process.exit(1);
  }
  bundledJs += `// ==========================================\n// MODULE: ${mod}\n// ==========================================\n`;
  bundledJs += readFileSync(modPath, 'utf8') + '\n\n';
}
console.log(`[Bundle] Assembled ${JS_MODULES.length} modular JS components (${bundledJs.length} bytes)`);

// 4. Inline CSS into HTML
const cssLinkRegex = /<link\b[^>]*href=["'][^"']*admin\.css[^"']*["'][^>]*\/?>/i;
if (!cssLinkRegex.test(html)) {
  console.error('FATAL BUILD ERROR: Could not find admin.css link tag in shared HTML!');
  process.exit(1);
}
const htmlInlinedCss = html.replace(cssLinkRegex, () => `<style>\n${css}\n</style>`);

// 5. Inline JS into HTML
let htmlBundled = htmlInlinedCss;
const modularScriptRegex = /(?:<!--\s*Modular Scripts[^\n]*-->\s*)?(?:<script\b[^>]*src=["'][^"']*\/js\/[^"']+["'][^>]*>(?:\s*<\/script>)?\s*)+/i;
const singleScriptRegex = /<script\b[^>]*src=["'][^"']*admin\.js[^"']*["'][^>]*>(?:\s*<\/script>)?/i;

if (modularScriptRegex.test(htmlBundled)) {
  htmlBundled = htmlBundled.replace(modularScriptRegex, () => `<script>\n${bundledJs}\n</script>`);
} else if (singleScriptRegex.test(htmlBundled)) {
  htmlBundled = htmlBundled.replace(singleScriptRegex, () => `<script>\n${bundledJs}\n</script>`);
} else {
  htmlBundled = htmlBundled.replace('</body>', `<script>\n${bundledJs}\n</script>\n</body>`);
}

// 6. Fail-Fast Verification Gates
if (!htmlBundled.includes('<style>') || !htmlBundled.includes(css.slice(0, 40))) {
  console.error('FATAL BUILD ERROR: CSS was not properly inlined into bundled HTML!');
  process.exit(1);
}
if (/<link\b[^>]*admin\.css/i.test(htmlBundled)) {
  console.error('FATAL BUILD ERROR: Residual <link rel="stylesheet"> detected in bundled HTML!');
  process.exit(1);
}
if (/<script\b[^>]*src=["'][^"']*(?:admin\.js|\/js\/)/i.test(htmlBundled)) {
  console.error('FATAL BUILD ERROR: Residual external <script src> detected in bundled HTML!');
  process.exit(1);
}
if (!htmlBundled.includes('id="agentModal"') || !htmlBundled.includes('id="topVersionBadge"')) {
  console.error('FATAL BUILD ERROR: Expected key DOM elements missing in bundled HTML!');
  process.exit(1);
}

// 7. Write auto-generated standalone artifacts to agent-edgeone/
const autoGenBanner = '/* AUTO-GENERATED FROM shared/admin/ — DO NOT EDIT MANUALLY */\n';
writeFileSync(join(edgeoneDir, 'admin.js'), autoGenBanner + bundledJs, 'utf8');
writeFileSync(join(edgeoneDir, 'admin.css'), autoGenBanner + css, 'utf8');
writeFileSync(
  join(edgeoneDir, 'admin.html'),
  `<!-- AUTO-GENERATED FROM shared/admin/ — DO NOT EDIT MANUALLY -->\n${html}`,
  'utf8'
);
console.log('[Artifacts] Synced standalone files to agent-edgeone/ with auto-gen banners');

// 8. Emit EdgeOne edge-functions
const safe = htmlBundled.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const edgeBanner =
  '/**\n' +
  ' * Self-contained admin UI for OCRProxy EdgeOne.\n' +
  ' *\n' +
  ' *   Generated by scripts/build-admin.mjs from single source shared/admin/\n' +
  ' *   Do not edit this file directly.\n' +
  ' */\n\n';

const functionCode =
  edgeBanner +
  'function pageHtml() {\n' +
  '  return `' + safe + '`;\n' +
  '}\n\n' +
  'export function onRequestGet(context) {\n' +
  '  return new Response(pageHtml(), {\n' +
  '    status: 200,\n' +
  '    headers: {\n' +
  '      "content-type": "text/html; charset=utf-8",\n' +
  '      "cache-control": "no-store",\n' +
  '      "x-content-type-options": "nosniff",\n' +
  '      "x-frame-options": "DENY",\n' +
  '      "x-xss-protection": "1; mode=block",\n' +
  '      "referrer-policy": "strict-origin-when-cross-origin"\n' +
  '    },\n' +
  '  });\n' +
  '}\n\n' +
  'export function onRequestHead(context) {\n' +
  '  return onRequestGet(context);\n' +
  '}\n';

const edgeFuncDir = join(edgeoneDir, 'edge-functions');
const indexPath = join(edgeFuncDir, 'index.js');
const adminPath = join(edgeFuncDir, 'admin.js');

writeFileSync(indexPath, functionCode, 'utf8');
writeFileSync(adminPath, functionCode, 'utf8');
console.log(`[EdgeFunctions] Built ${indexPath} and ${adminPath} (${htmlBundled.length} bytes)`);

// 9. Sync edge-functions to project root
const rootEdgeFuncDir = join(projectRoot, 'edge-functions');
if (existsSync(rootEdgeFuncDir)) {
  writeFileSync(join(rootEdgeFuncDir, 'index.js'), functionCode, 'utf8');
  writeFileSync(join(rootEdgeFuncDir, 'admin.js'), functionCode, 'utf8');
  cpSync(edgeFuncDir, rootEdgeFuncDir, { recursive: true });
  console.log(`[Sync] Synced all edge-functions to root: ${rootEdgeFuncDir}`);
}

console.log('=== Admin build completed successfully ===\n');
