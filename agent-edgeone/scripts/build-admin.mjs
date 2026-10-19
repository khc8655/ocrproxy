#!/usr/bin/env node
/**
 * build-admin.mjs — bundle EdgeOne dedicated admin UI ({html,css,js}) and shared
 * components (shared/admin/js/agent-models-ui.js) into self-contained EdgeOne edge functions:
 *   - edge-functions/index.js (GET / -> 302 /admin; tiny, so the console bundle is not shipped twice)
 *   - edge-functions/admin.js (serves GET /admin or 301 redirects)
 *
 * Also syncs VM modular admin sources (shared/admin/) to vm-app/static/.
 *
 * Architecture Rule 1: EdgeOne has its dedicated console skeleton (Vault Hub)
 * while sharing sub-components (agent-models-ui.js).
 */
import { readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// 1. Sync shared/admin to vm-app/static ONLY (NEVER overwrite agent-edgeone!)
if (existsSync(sharedRoot)) {
  const sharedHtml = join(sharedRoot, 'admin.html');
  const sharedCss = join(sharedRoot, 'admin.css');
  const sharedJsDir = join(sharedRoot, 'js');

  const vmStatic = join(projectRoot, 'vm-app', 'static');
  if (existsSync(vmStatic)) {
    if (existsSync(sharedHtml)) {
      let vmHtml = readFileSync(sharedHtml, 'utf8');
      vmHtml = vmHtml.replace(/(\.js\?v=)[^"']+/g, `$1${appVersion}`);
      vmHtml = vmHtml.replace(/(id="topVersionBadge"[^>]*>)[^<]+(<\/span>)/g, `$1v${appVersion}$2`);
      writeFileSync(join(vmStatic, 'admin.html'), vmHtml, 'utf8');
    }
    if (existsSync(sharedCss)) cpSync(sharedCss, join(vmStatic, 'admin.css'));
    if (existsSync(sharedJsDir)) cpSync(sharedJsDir, join(vmStatic, 'js'), { recursive: true });
    console.log(`[Sync] Synced shared/admin to vm-app/static with version ${appVersion}: ${vmStatic}`);
  }
}

// 2. Read EdgeOne Dedicated Sources: agent-edgeone/admin.{html,css,js}
const htmlPath = join(root, 'admin.html');
const cssPath = join(root, 'admin.css');
const jsPath = join(root, 'admin.js');

const edgeFuncDir = join(root, 'edge-functions');
const indexPath = join(edgeFuncDir, 'index.js');
const adminPath = join(edgeFuncDir, 'admin.js');

if (!existsSync(htmlPath) || !existsSync(cssPath) || !existsSync(jsPath)) {
  console.error(`FATAL: Missing EdgeOne dedicated source input: ${htmlPath}, ${cssPath}, or ${jsPath}`);
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

// 3. Read EdgeOne standalone JS & Bundle Shared Component: agent-models-ui.js
const agentModelsUiPath = join(sharedRoot, 'js', 'agent-models-ui.js');
let bundledJs = '';
// Same host adapter as the VM console (HOST.api / HOST.buildTestBody), pinned to the EdgeOne kind.
const hostJsPath = join(sharedRoot, 'js', 'host.js');
if (!existsSync(hostJsPath)) {
  console.error(`FATAL: Missing shared host adapter: ${hostJsPath}`);
  process.exit(1);
}
bundledJs += "window.__HOST_KIND__ = 'edgeone';\n" + readFileSync(hostJsPath, 'utf8') + '\n\n';
console.log(`[Component] Bundled shared host adapter: ${hostJsPath}`);
if (existsSync(agentModelsUiPath)) {
  bundledJs += readFileSync(agentModelsUiPath, 'utf8') + '\n\n';
  console.log(`[Component] Bundled shared agent-models-ui component: ${agentModelsUiPath}`);
}
bundledJs += readFileSync(jsPath, 'utf8');

// 4. Inline CSS: replace <link ...admin.css...> with <style>
const cssLinkRegex = /<link\b[^>]*href=["'][^"']*admin\.css[^"']*["'][^>]*\/?>/i;
if (!cssLinkRegex.test(html)) {
  console.error('FATAL BUILD ERROR: Could not find admin.css link tag in EdgeOne HTML!');
  process.exit(1);
}
const htmlInlinedCss = html.replace(cssLinkRegex, () => `<style>\n${css}\n</style>`);

// 5. Inline JS: replace modular or standalone <script src="...admin.js"> with single <script>
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

// 6. Auto-inject dynamic version into bundled HTML and JS constants
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

// 架构规范铁律断言：必须是 EdgeOne 专属控制台，严禁被 VM 骨架污染
if (!htmlBundled.includes('OCRProxy EdgeOne 控制台') || !htmlBundled.includes('EdgeOne 边缘版')) {
  console.error('FATAL BUILD ERROR: EdgeOne dedicated console identity missing! ARCHITECTURE_STANDARDS Rule 1 violated.');
  process.exit(1);
}
if (!htmlBundled.includes('已纳管供应商') || !htmlBundled.includes('id="panel-providers"')) {
  console.error('FATAL BUILD ERROR: EdgeOne Vault Hub (Providers panel) missing! ARCHITECTURE_STANDARDS Rule 1 violated.');
  process.exit(1);
}
if (htmlBundled.includes('Agent 智能体直连') || htmlBundled.includes('KB 知识库入库')) {
  console.error('FATAL BUILD ERROR: VM-specific labels detected in EdgeOne bundle! Contamination detected.');
  process.exit(1);
}
if (!htmlBundled.includes('renderAgentModels') || !htmlBundled.includes('saveAgentModel')) {
  console.error('FATAL BUILD ERROR: Shared agent-models-ui component functions missing from bundle!');
  process.exit(1);
}

// 超时能力一致性红线断言
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
if (!/id="set_upstream_timeout_sec"[^>]*max="300"/i.test(htmlBundled)) {
  console.error('FATAL BUILD ERROR: set_upstream_timeout_sec must have max="300"! Red Line 2 violated.');
  process.exit(1);
}
if (!htmlBundled.includes('id="set_max_retries"')) {
  console.error('FATAL BUILD ERROR: set_max_retries input missing from admin HTML!');
  process.exit(1);
}
if (/Math\.min\(\s*30\s*,\s*upTimeout\s*\)/.test(bundledJs)) {
  console.error('FATAL BUILD ERROR: Obsolete Math.min(30, upTimeout) budget truncation detected in admin.js! Red Line 2 violated.');
  process.exit(1);
}

// 7. Emit EdgeOne edge functions
writeFileSync(join(root, 'admin.bundled.html'), htmlBundled, 'utf8');
const safe = htmlBundled.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const banner =
  '/**\n' +
  ' * Self-contained admin UI for OCRProxy EdgeOne.\n' +
  ' *\n' +
  ' *   Generated by scripts/build-admin.mjs from agent-edgeone/admin.* + shared components\n' +
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

// "/" only redirects: shipping the ~190KB console twice doubled the code every
// isolate loads (cold-start CPU) for no benefit.
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
  cpSync(edgeFuncDir, rootEdgeFuncDir, { recursive: true });
  console.log(`[Sync] Synced all edge-functions to root: ${rootEdgeFuncDir}`);
}

console.log('=== EdgeOne admin build completed successfully ===\n');
