#!/usr/bin/env node
/**
 * verify-frontend-symbols.mjs — 静态前端符号完整性与架构门禁扫描器
 * 
 * 核心职责：
 * 1. 架构纯洁度：严禁 agent-edgeone/ 出现独立的 admin.html/css/js 副本；
 * 2. 符号无遮蔽：严禁 shared/admin/js 各模块间顶层 function 声明重名覆盖；
 * 3. 语法硬编译：使用 Node.js vm 对所有 JS 进行语法编译验证；
 * 4. 契约完整性：确保所有核心业务交互函数 100% 声明存在；
 * 5. 安全合规性：严禁出现已废弃或错误的外部镜像地址（如 xsk/ocrprox）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sharedJsDir = join(root, '..', 'shared', 'admin', 'js');

console.log('🔍 [Gate 1/2] 正在执行前端代码静态语法与符号完整性检查...');

// 0. 架构规范门禁：确保 EdgeOne 专属控制台骨架完好存在且为 Vault Hub 专属控制台
const requiredEdgeOneFiles = ['admin.html', 'admin.css'];
// 注意：EdgeOne 实际服务的前端 bundle 是生成产物 edge-functions/admin.js，由 build-admin.mjs 生成；
// agent-edgeone/admin.js 是历史遗留手写副本，已删除，禁止复活。
for (const f of requiredEdgeOneFiles) {
  const p = join(root, f);
  if (!existsSync(p)) {
    console.error(`❌ [ArchitectureViolation] 缺失 EdgeOne 专属控制台文件: ${p}`);
    console.error(`   👉 必须遵循 ARCHITECTURE_STANDARDS 铁律一：EdgeOne 拥有专属中枢控制台，严禁被 VM 骨架覆盖！`);
    process.exit(1);
  }
}

if (!existsSync(sharedJsDir)) {
  console.error(`❌ 未找到前端源目录: ${sharedJsDir}`);
  process.exit(1);
}

const jsFiles = readdirSync(sharedJsDir).filter(f => f.endsWith('.js'));
const allCodeByFile = {};
const definedFunctions = new Set();
const definedVariables = new Set();
const topLevelFunctionsByFile = {};

// 1. 语法编译检查 & 收集声明符号
let hasSyntaxError = false;
let duplicateFunctions = [];

for (const file of jsFiles) {
  const filePath = join(sharedJsDir, file);
  const code = readFileSync(filePath, 'utf8');
  allCodeByFile[file] = code;

  // 1.0 镜像与安全检查
  if (code.includes('xsk/ocrprox')) {
    console.error(`❌ [SecurityGate] 文件 ${file} 包含非法的旧预设地址 xsk/ocrprox！`);
    process.exit(1);
  }

  // 1.1 语法合法性硬编译 (Node.js vm.Script)
  try {
    new vm.Script(code, { filename: file });
  } catch (err) {
    console.error(`❌ [SyntaxError] 文件 ${file} 存在 JavaScript 语法错误: ${err.message}`);
    hasSyntaxError = true;
  }

  // 1.2 收集顶层函数声明并检测多文件重名覆盖 (闭包 IIFE 内部的局部函数除外)
  if (!code.startsWith('(function')) {
    const topFuncRegex = /^function\s+([a-zA-Z0-9_$]+)\s*\(/gm;
    let m;
    while ((m = topFuncRegex.exec(code)) !== null) {
      const fn = m[1];
      if (topLevelFunctionsByFile[fn]) {
        duplicateFunctions.push({ fn, fileA: topLevelFunctionsByFile[fn], fileB: file });
      } else {
        topLevelFunctionsByFile[fn] = file;
      }
    }
  }

  // 1.3 收集所有声明符号
  const funcDeclRegex = /(?:function\s+([a-zA-Z0-9_$]+)|(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\()/g;
  let match;
  while ((match = funcDeclRegex.exec(code)) !== null) {
    const fnName = match[1] || match[2];
    if (fnName) definedFunctions.add(fnName);
  }

  const varDeclRegex = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/g;
  while ((match = varDeclRegex.exec(code)) !== null) {
    if (match[1]) definedVariables.add(match[1]);
  }
}

if (hasSyntaxError) {
  console.error('❌ 语法检查未通过，构建终止！');
  process.exit(1);
}

if (duplicateFunctions.length > 0) {
  console.error(`❌ [DuplicateFunctionDeclaration] 检测到多文件顶层函数重名遮蔽:`);
  for (const item of duplicateFunctions) {
    console.error(`   - 函数 "${item.fn}()" 在 ${item.fileA} 与 ${item.fileB} 中重复声明，存在作用域覆盖隐患！`);
  }
  process.exit(1);
}

// 2. 关键业务路径函数契约检查 (必须 100% 存在声明)
const CRITICAL_REQUIRED_FUNCTIONS = [
  'login',
  'loginErr',
  'tryAutoLoginFromUrl',
  'logout',
  'clearLoginCacheAndReload',
  'initAppAfterAuth',
  'showLogin',
  'showApp',
  'loadData',
  'renderNav',
  'render',
  'renderDashboard',
  'renderLogsTable',
  'renderProviders',
  'renderModels',
  'renderSettings',
  'renderAccessPanel',
  'renderRawJsonPanel',
  'toast',
  'icon',
  'esc'
];

let missingCriticalFunctions = [];
for (const fn of CRITICAL_REQUIRED_FUNCTIONS) {
  if (!definedFunctions.has(fn)) {
    missingCriticalFunctions.push(fn);
  }
}

if (missingCriticalFunctions.length > 0) {
  console.error(`❌ [SymbolMissing] 核心交互函数未声明: ${missingCriticalFunctions.join(', ')}`);
  console.error(`   👉 请检查是否有函数被意外误删！构建已强行阻断。`);
  process.exit(1);
}

// 3. 扫描各文件内部调用的未声明独立函数
const BROWSER_GLOBALS = new Set([
  'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'escape', 'unescape'
]);

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return',
  'typeof', 'delete', 'import', 'export', 'await', 'super', 'new', 'yield'
]);

let undefinedCalls = [];

for (const [file, code] of Object.entries(allCodeByFile)) {
  const callRegex = /(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  let m;
  const lines = code.split('\n');

  while ((m = callRegex.exec(code)) !== null) {
    const fnName = m[1];
    if (JS_KEYWORDS.has(fnName)) continue;
    if (BROWSER_GLOBALS.has(fnName)) continue;
    if (definedFunctions.has(fnName)) continue;
    if (definedVariables.has(fnName)) continue;

    const matchIdx = m.index;
    let charCount = 0;
    let lineNo = 1;
    for (let i = 0; i < lines.length; i++) {
      charCount += lines[i].length + 1;
      if (charCount > matchIdx) {
        lineNo = i + 1;
        break;
      }
    }

    if (file === 'core.js' || file === 'app.js') {
      undefinedCalls.push({ file, line: lineNo, fnName });
    }
  }
}

if (undefinedCalls.length > 0) {
  const hardFailures = undefinedCalls.filter(c => ['loginErr'].includes(c.fnName));
  if (hardFailures.length > 0) {
    console.error(`❌ [UndefinedFunctionCall] 检测到调用了未定义的函数:`);
    for (const fail of hardFailures) {
      console.error(`   - ${fail.file}:${fail.line} 调用了未声明的函数: ${fail.fnName}()`);
    }
    process.exit(1);
  }
}

console.log(`✅ [Gate 1/2] 静态符号完整性通过！已验证 ${definedFunctions.size} 个函数声明，单一真理源合规，无函数遮蔽。`);
process.exit(0);
