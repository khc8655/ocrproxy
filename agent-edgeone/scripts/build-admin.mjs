#!/usr/bin/env node
/**
 * build-admin.mjs — bundle single-source shared/admin into self-contained
 * EdgeOne edge functions and sync static assets to vm-app/static:
 *   - edge-functions/index.js (serves GET / directly as admin dashboard)
 *   - edge-functions/admin.js (serves GET /admin or 301 redirects)
 *
 * Single Source of Truth: shared/admin/ ONLY.
 */
import { readFileSync, writeFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sharedRoot = join(root, '..', 'shared', 'admin');
const configRoot = join(root, '..', 'shared', 'config');

// 0. Read dynamic version from root version.json (Single Source of Truth)
const versionJsonPath = join(root, '..', 'version.json');
let appVersion = 'latest';
if (existsSync(versionJsonPath)) {
  try {
    const vData = JSON.parse(readFileSync(versionJsonPath, 'utf8'));
    appVersion = (vData.version || '').replace(/^v/, '') || 'latest';
  } catch (e) {
    console.warn('Could not read version.json:', e.message);
  }
}

// 1. Sync shared/admin to vm-app/static (NEVER overwrite source shared/admin!)
if (existsSync(sharedRoot)) {
  const sharedHtml = join(sharedRoot, 'admin.html');
  const sharedCss = join(sharedRoot, 'admin.css');
  const sharedJsDir = join(sharedRoot, 'js');

  const vmStatic = join(root, '..', 'vm-app', 'static');
  if (existsSync(vmStatic)) {
    if (existsSync(sharedHtml)) {
      let vmHtml = readFileSync(sharedHtml, 'utf8');
      // Auto-inject version into script tags in target artifact only
      vmHtml = vmHtml.replace(/(\.js\?v=)[^"']+/g, `$1${appVersion}`);
      writeFileSync(join(vmStatic, 'admin.html'), vmHtml, 'utf8');
    }
    if (existsSync(sharedCss)) cpSync(sharedCss, join(vmStatic, 'admin.css'));
    if (existsSync(sharedJsDir)) cpSync(sharedJsDir, join(vmStatic, 'js'), { recursive: true });
    console.log(`Synced shared/admin to vm-app/static with version ${appVersion}: ${vmStatic}`);
  }
}

// 2. Read Single Source of Truth: shared/admin/admin.html and admin.css
const htmlPath = join(sharedRoot, 'admin.html');
const cssPath = join(sharedRoot, 'admin.css');
const sharedJsDir = join(sharedRoot, 'js');

const indexPath = join(root, 'edge-functions', 'index.js');
const adminPath = join(root, 'edge-functions', 'admin.js');

if (!existsSync(htmlPath) || !existsSync(cssPath)) {
  console.error(`Missing single source of truth input: ${htmlPath} or ${cssPath}`);
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

// 3. Load Schema JSON & Bundle JS in Dependency Order
const schemaPath = join(configRoot, 'settings.schema.json');
let schemaJsonStr = '{}';
if (existsSync(schemaPath)) {
  schemaJsonStr = readFileSync(schemaPath, 'utf8');
}

let bundledJs = `// Injected Host Runtime & Schema Metadata\nwindow.__HOST_KIND__ = 'edgeone';\nwindow.SETTINGS_SCHEMA = ${schemaJsonStr};\n\n`;

const jsLoadOrder = [
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

for (const jsFile of jsLoadOrder) {
  const p = join(sharedJsDir, jsFile);
  if (existsSync(p)) {
    bundledJs += `\n/* --- ${jsFile} --- */\n` + readFileSync(p, 'utf8') + '\n';
  } else {
    console.warn(`Warning: shared JS file not found: ${p}`);
  }
}

// 4. Inline CSS: replace <link ...admin.css...> with <style>
const cssLinkRegex = /<link\b[^>]*href=["'][^"']*admin\.css[^"']*["'][^>]*\/?>/i;
if (!cssLinkRegex.test(html)) {
  console.error('FATAL BUILD ERROR: Could not find admin.css link tag in HTML!');
  process.exit(1);
}
const htmlInlinedCss = html.replace(cssLinkRegex, () => `<style>\n${css}\n</style>`);

// 5. Inline JS: replace modular <script src="/static/js/..."></script> with single <script>
let htmlBundled = htmlInlinedCss;
const modularScriptRegex = /(?:<!--\s*Modular Scripts[^\n]*-->\s*)?(?:<script\b[^>]*src=["'][^"']*(?:\/static)?\/js\/[^"']+["'][^>]*>(?:\s*<\/script>)?\s*)+/i;
const singleScriptRegex = /<script\b[^>]*src=["'][^"']*admin\.js[^"']*["'][^>]*>(?:\s*<\/script>)?/i;

if (modularScriptRegex.test(htmlBundled)) {
  htmlBundled = htmlBundled.replace(modularScriptRegex, () => `<script>\n${bundledJs}\n</script>`);
} else if (singleScriptRegex.test(htmlBundled)) {
  htmlBundled = htmlBundled.replace(singleScriptRegex, () => `<script>\n${bundledJs}\n</script>`);
} else {
  htmlBundled = htmlBundled.replace('</body>', `<script>\n${bundledJs}\n</script>\n</body>`);
}

// 5.1 Auto-inject dynamic version into bundled HTML and JS constants
if (appVersion && appVersion !== 'latest') {
  htmlBundled = htmlBundled.replace(/(id="topVersionBadge"[^>]*>)[^<]+(<\/span>)/g, `$1v${appVersion}$2`);
  htmlBundled = htmlBundled.replace(/(id="statVersion"[^>]*>)[^<]+(<\/div>)/g, `$1v${appVersion}$2`);
  htmlBundled = htmlBundled.replace(/(const BUILD_VERSION\s*=\s*['"])[^'"]+(['"];)/g, `$1v${appVersion}$2`);
}

// === 编译严格强断言 (Fail-Fast Gatekeeper) ===
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
if (!htmlBundled.includes('renderAgentModels') || !htmlBundled.includes('renderProviders')) {
  console.error('FATAL BUILD ERROR: Core functions missing from bundle!');
  process.exit(1);
}

// 6. Emit edge functions
writeFileSync(join(root, 'admin.bundled.html'), htmlBundled, 'utf8');
const safe = htmlBundled.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const banner =
  '/**\n' +
  ' * Self-contained admin UI for OCRProxy EdgeOne.\n' +
  ' *\n' +
  ' *   Generated by scripts/build-admin.mjs from shared/admin sources\n' +
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

const rootProject = join(root, '..');
const rootIndexPath = join(rootProject, 'edge-functions', 'index.js');
const rootAdminPath = join(rootProject, 'edge-functions', 'admin.js');

writeFileSync(indexPath, functionCode, 'utf8');
writeFileSync(adminPath, functionCode, 'utf8');
console.log(`Built ${indexPath} and ${adminPath} (${htmlBundled.length} bytes of HTML bundled from shared/admin)`);

if (existsSync(join(rootProject, 'edge-functions'))) {
  writeFileSync(rootIndexPath, functionCode, 'utf8');
  writeFileSync(rootAdminPath, functionCode, 'utf8');
  cpSync(join(root, 'edge-functions'), join(rootProject, 'edge-functions'), { recursive: true });
  console.log(`Synced all edge-functions to root: ${join(rootProject, 'edge-functions')}`);
}
