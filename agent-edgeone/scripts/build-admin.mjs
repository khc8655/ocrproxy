#!/usr/bin/env node
/**
 * build-admin.mjs — Single Source of Truth Builder
 *
 * Direct consumer of shared/admin/ ({admin.html, admin.css, js/*}) for:
 *   1. vm-app/static/ (modular assets with version stamping)
 *   2. agent-edgeone/ (self-contained EdgeOne bundle inlined into edge-functions/{admin.js, index.js})
 *
 * Adheres strictly to Architecture Rule: Single Source of Truth (Plan A).
 * No divergent hand-written admin.html / admin.js.
 */
import { readFileSync, writeFileSync, existsSync, cpSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mirror generator: copy every source file AND delete files that no longer exist in
// the source, so a removed/renamed edge module can never linger in the root mirror.
function listFiles(dir, rel = '') {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const nextRel = rel ? join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(join(dir, ent.name), nextRel));
    else if (ent.isFile()) out.push(nextRel);
  }
  return out;
}

function syncTree(src, dest) {
  if (!existsSync(dest)) { cpSync(src, dest, { recursive: true }); return; }
  const srcFiles = new Set(listFiles(src));
  for (const rel of listFiles(dest)) {
    if (!srcFiles.has(rel)) {
      rmSync(join(dest, rel));
      console.log(`[Mirror] pruned stale file: ${join(dest, rel)}`);
    }
  }
  for (const rel of srcFiles) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(src, rel), target);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const projectRoot = join(root, '..');
const sharedRoot = join(projectRoot, 'shared', 'admin');

// 0. Read dynamic version from root version.json (Single Source of Truth)
const versionJsonPath = join(projectRoot, 'version.json');
let appVersion = 'latest';
if (existsSync(versionJsonPath)) {
  try {
    const vData = JSON.parse(readFileSync(versionJsonPath, 'utf8'));
    appVersion = (vData.version || '').replace(/^v/, '') || 'latest';
  } catch (e) {
    console.warn('Could not read version.json:', e.message);
  }
}

// 1. Sync shared/admin to vm-app/static/
if (existsSync(sharedRoot)) {
  const sharedHtml = join(sharedRoot, 'admin.html');
  const sharedCss = join(sharedRoot, 'admin.css');
  const sharedJsDir = join(sharedRoot, 'js');

  const vmStatic = join(projectRoot, 'vm-app', 'static');
  if (existsSync(vmStatic)) {
    if (existsSync(sharedHtml)) {
      let vmHtml = readFileSync(sharedHtml, 'utf8');
      vmHtml = vmHtml.replace(/(\.js\?v=)[^"']+/g, `$1${appVersion}`);
      vmHtml = vmHtml.replace(/(\.css\?v=)[^"']+/g, `$1${appVersion}`);
      vmHtml = vmHtml.replace(/(id="topVersionBadge"[^>]*>)[^<]+(<\/span>)/g, `$1v${appVersion}$2`);
      writeFileSync(join(vmStatic, 'admin.html'), vmHtml, 'utf8');
    }
    if (existsSync(sharedCss)) cpSync(sharedCss, join(vmStatic, 'admin.css'));
    if (existsSync(sharedJsDir)) cpSync(sharedJsDir, join(vmStatic, 'js'), { recursive: true });
    console.log(`[Sync] Synced shared/admin to vm-app/static with version ${appVersion}: ${vmStatic}`);
  }
}

// 2. Read Base Template from shared/admin/ (Single Source of Truth)
const sharedHtmlPath = join(sharedRoot, 'admin.html');
const sharedCssPath = join(sharedRoot, 'admin.css');
const sharedJsDir = join(sharedRoot, 'js');

if (!existsSync(sharedHtmlPath) || !existsSync(sharedCssPath) || !existsSync(sharedJsDir)) {
  console.error(`FATAL: Missing shared source input in ${sharedRoot}`);
  process.exit(1);
}

let html = readFileSync(sharedHtmlPath, 'utf8');
const css = readFileSync(sharedCssPath, 'utf8');

// 3. Assemble EdgeOne JS Bundle from shared/admin/js/ modules
const jsModuleOrder = [
  'host.js',
  'settings-form.js',
  'core.js',
  'vault.js',
  'providers.js',
  'agent-models-ui.js',
  'models.js',
  'settings.js',
  'app.js'
];

let bundledJs = "window.__HOST_KIND__ = 'edgeone';\n\n";

for (const modName of jsModuleOrder) {
  const modPath = join(sharedJsDir, modName);
  if (!existsSync(modPath)) {
    console.error(`FATAL: Missing required shared JS module: ${modPath}`);
    process.exit(1);
  }
  bundledJs += `/* --- Module: ${modName} --- */\n` + readFileSync(modPath, 'utf8') + '\n\n';
  console.log(`[Bundle] Inlined shared JS module: ${modName}`);
}

// 4. Inline CSS: replace <link ...admin.css...> with <style>
const cssLinkRegex = /<link\b[^>]*href=["'][^"']*admin\.css[^"']*["'][^>]*\/?>/i;
if (!cssLinkRegex.test(html)) {
  console.error('FATAL BUILD ERROR: Could not find admin.css link tag in shared HTML!');
  process.exit(1);
}
let htmlBundled = html.replace(cssLinkRegex, () => `<style>\n${css}\n</style>`);

// 5. Inline JS: replace modular <script ...> with single <script>
const modularScriptRegex = /(?:<!--\s*Modular Scripts[^\n]*-->\s*)?(?:<script\b[^>]*src=["'][^"']*(?:\/static)?\/js\/[^"']+["'][^>]*>(?:\s*<\/script>)?\s*)+/i;
const singleScriptRegex = /<script\b[^>]*src=["'][^"']*admin\.js[^"']*["'][^>]*>(?:\s*<\/script>)?/i;

if (modularScriptRegex.test(htmlBundled)) {
  htmlBundled = htmlBundled.replace(modularScriptRegex, () => `<script>\n${bundledJs}\n</script>`);
} else if (singleScriptRegex.test(htmlBundled)) {
  htmlBundled = htmlBundled.replace(singleScriptRegex, () => `<script>\n${bundledJs}\n</script>`);
} else {
  htmlBundled = htmlBundled.replace('</body>', `<script>\n${bundledJs}\n</script>\n</body>`);
}

// 6. Inject dynamic version and EdgeOne exclusive static identity
htmlBundled = htmlBundled.replace(/<title>[^<]+<\/title>/i, '<title>OCRProxy EdgeOne 控制台</title>');
htmlBundled = htmlBundled.replace(
  /<span class="brand-badge"[^>]*id="topModeBadge"[^>]*>[^<]+<\/span>/i,
  '<span class="brand-badge badge-edgeone" id="topModeBadge">EdgeOne 边缘版</span>'
);

if (appVersion && appVersion !== 'latest') {
  htmlBundled = htmlBundled.replace(/(id="topVersionBadge"[^>]*>)[^<]+(<\/span>)/g, `$1v${appVersion}$2`);
  htmlBundled = htmlBundled.replace(/(id="statVersion"[^>]*>)[^<]+(<\/div>)/g, `$1v${appVersion}$2`);
  htmlBundled = htmlBundled.replace(/(const BUILD_VERSION\s*=\s*['"])[^'"]+(['"];)/g, `$1v${appVersion}$2`);
}

// === Fail-Fast Quality Gate Assertions ===
// 1. EdgeOne Identity & SSOT Gates (Prevent deploying as VM Agent version)
if (!htmlBundled.includes('OCRProxy EdgeOne 控制台')) {
  console.error('FATAL BUILD ERROR: EdgeOne console title missing from bundle! Potential VM Agent pollution.');
  process.exit(1);
}
if (!htmlBundled.includes('EdgeOne 边缘版')) {
  console.error('FATAL BUILD ERROR: EdgeOne edition badge missing from bundle! Potential VM Agent pollution.');
  process.exit(1);
}
if (!htmlBundled.includes("window.__HOST_KIND__ = 'edgeone'")) {
  console.error('FATAL BUILD ERROR: window.__HOST_KIND__ = \'edgeone\' missing from bundle!');
  process.exit(1);
}

// 2. CSS & JS Inlining Completeness
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
if (!htmlBundled.includes('id="panel-providers"')) {
  console.error('FATAL BUILD ERROR: Providers panel missing from bundle! Vault Hub corrupted.');
  process.exit(1);
}
if (!htmlBundled.includes('renderAgentModels') || !htmlBundled.includes('saveAgentModel')) {
  console.error('FATAL BUILD ERROR: Shared agent-models-ui component functions missing from bundle!');
  process.exit(1);
}

// Timeout Consistency & Red Line Gate
if (htmlBundled.includes('EdgeOne 建议 20~25s') || htmlBundled.includes('20~25s')) {
  console.error('FATAL BUILD ERROR: Obsolete "EdgeOne 建议 20~25s" detected in admin HTML! Red Line 2 violated.');
  process.exit(1);
}
if (htmlBundled.includes('value="25"')) {
  console.error('FATAL BUILD ERROR: Ghost "value=\\"25\\"" detected in admin HTML! Red Line 2 violated.');
  process.exit(1);
}
if (htmlBundled.includes('xsk/ocrprox')) {
  console.error('FATAL BUILD ERROR: Broken mirror "xsk/ocrprox" detected in admin HTML/JS! Security violated.');
  process.exit(1);
}
if (!/id="s_chatTimeout"[^>]*max="300"/i.test(htmlBundled)) {
  console.error('FATAL BUILD ERROR: s_chatTimeout must have max="300"! Red Line 2 violated.');
  process.exit(1);
}

// 7. Emit EdgeOne edge functions & synced copies
writeFileSync(join(root, 'admin.bundled.html'), htmlBundled, 'utf8');

// Prepare synced agent-edgeone/admin.html with EdgeOne static identity
let eoHtmlTemplate = html.replace(/<title>[^<]+<\/title>/i, '<title>OCRProxy EdgeOne 控制台</title>');
eoHtmlTemplate = eoHtmlTemplate.replace(
  /<span class="brand-badge"[^>]*id="topModeBadge"[^>]*>[^<]+<\/span>/i,
  '<span class="brand-badge badge-edgeone" id="topModeBadge">EdgeOne 边缘版</span>'
);
if (appVersion && appVersion !== 'latest') {
  eoHtmlTemplate = eoHtmlTemplate.replace(/(id="topVersionBadge"[^>]*>)[^<]+(<\/span>)/g, `$1v${appVersion}$2`);
  eoHtmlTemplate = eoHtmlTemplate.replace(/(\.js\?v=)[^"']+/g, `$1${appVersion}`);
  eoHtmlTemplate = eoHtmlTemplate.replace(/(\.css\?v=)[^"']+/g, `$1${appVersion}`);
}
writeFileSync(join(root, 'admin.html'), eoHtmlTemplate, 'utf8');
writeFileSync(join(root, 'admin.css'), css, 'utf8');

const edgeFuncDir = join(root, 'edge-functions');
const indexPath = join(edgeFuncDir, 'index.js');
const adminPath = join(edgeFuncDir, 'admin.js');

const safe = htmlBundled.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const banner =
  '/**\n' +
  ' * Self-contained admin UI for OCRProxy EdgeOne.\n' +
  ' *\n' +
  ' *   Generated by scripts/build-admin.mjs from shared/admin/ ({html,css,js}) — Single Source of Truth\n' +
  ' *   Do not edit this file directly.\n' +
  ' */\n\n';

const functionCode =
  banner +
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

const indexCode =
  '/**\n' +
  ' * GET / -> /admin (EdgeOne console). Generated by scripts/build-admin.mjs; do not edit.\n' +
  ' */\n' +
  'export function onRequestGet(context) {\n' +
  '  const url = new URL(context.request.url);\n' +
  '  url.pathname = "/admin";\n' +
  '  return new Response(null, { status: 302, headers: { location: url.pathname + url.search, "cache-control": "no-store" } });\n' +
  '}\n\n' +
  'export function onRequestHead(context) {\n' +
  '  return onRequestGet(context);\n' +
  '}\n';

writeFileSync(indexPath, indexCode, 'utf8');
writeFileSync(adminPath, functionCode, 'utf8');
console.log(`[EdgeFunctions] Built ${indexPath} and ${adminPath} (${htmlBundled.length} bytes of HTML bundled)`);

const rootEdgeFuncDir = join(projectRoot, 'edge-functions');
if (existsSync(rootEdgeFuncDir)) {
  writeFileSync(join(rootEdgeFuncDir, 'index.js'), indexCode, 'utf8');
  writeFileSync(join(rootEdgeFuncDir, 'admin.js'), functionCode, 'utf8');
  syncTree(edgeFuncDir, rootEdgeFuncDir);
  console.log(`[Sync] Synced all edge-functions to root: ${rootEdgeFuncDir}`);
}

console.log('=== EdgeOne admin build completed successfully from Single Source of Truth ===\n');
