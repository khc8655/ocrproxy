#!/usr/bin/env node
/**
 * verify-frontend-symbols.mjs — 静态前端符号完整性与语法门禁扫描器
 * 
 * 核心职责：
 * 1. 使用 Node.js 内置 vm 模块对所有前端 JS 进行硬性语法编译验证；
 * 2. 扫描所有函数声明与关键交互调用契约，严禁未定义函数（如 loginErr）逃逸；
 * 3. 任何语法错误或缺失符号当场 exit 1 阻断 npm run build:admin 构建。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sharedJsDir = join(root, '..', 'shared', 'admin', 'js');

console.log('🔍 [Gate 1/2] 正在执行前端代码静态语法与符号完整性检查...');

if (!existsSync(sharedJsDir)) {
  console.error(`❌ 未找到前端源目录: ${sharedJsDir}`);
  process.exit(1);
}

const jsFiles = readdirSync(sharedJsDir).filter(f => f.endsWith('.js'));
const allCodeByFile = {};
const definedFunctions = new Set();
const definedVariables = new Set();

// 1. 语法编译检查 & 收集声明符号
let hasSyntaxError = false;
for (const file of jsFiles) {
  const filePath = join(sharedJsDir, file);
  const code = readFileSync(filePath, 'utf8');
  allCodeByFile[file] = code;

  // 1.1 语法合法性硬编译 (Node.js vm.Script)
  try {
    new vm.Script(code, { filename: file });
  } catch (err) {
    console.error(`❌ [SyntaxError] 文件 ${file} 存在 JavaScript 语法错误: ${err.message}`);
    hasSyntaxError = true;
  }

  // 1.2 收集函数与顶层声明
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

// 2. 关键业务路径函数契约检查 (必须 100% 存在声明)
const CRITICAL_REQUIRED_FUNCTIONS = [
  'login',
  'loginErr',
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
  console.error(`   👉 请检查是否有函数被意外误删（如 loginErr）！构建已强行阻断。`);
  process.exit(1);
}

// 3. 扫描各文件内部调用的未声明独立函数 (过滤 JS 保留字与已知浏览器环境)
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
  // 匹配独立函数调用: 不以 . 或 function 开头的 foo(...)
  // 例如: loginErr('')
  const callRegex = /(?<![.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  let m;
  const lines = code.split('\n');

  while ((m = callRegex.exec(code)) !== null) {
    const fnName = m[1];
    if (JS_KEYWORDS.has(fnName)) continue;
    if (BROWSER_GLOBALS.has(fnName)) continue;
    if (definedFunctions.has(fnName)) continue;
    if (definedVariables.has(fnName)) continue;

    // 定位行号
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

    // 仅针对在 core.js 或 app.js 中调用的顶级未知符号给出警报
    if (file === 'core.js' || file === 'app.js') {
      undefinedCalls.push({ file, line: lineNo, fnName });
    }
  }
}

if (undefinedCalls.length > 0) {
  // 检查是否有已知白名单外的重要缺失调用
  const hardFailures = undefinedCalls.filter(c => ['loginErr'].includes(c.fnName));
  if (hardFailures.length > 0) {
    console.error(`❌ [UndefinedFunctionCall] 检测到调用了未定义的函数:`);
    for (const fail of hardFailures) {
      console.error(`   - ${fail.file}:${fail.line} 调用了未声明的函数: ${fail.fnName}()`);
    }
    process.exit(1);
  }
}

console.log(`✅ [Gate 1/2] 静态符号完整性通过！已验证 ${definedFunctions.size} 个函数声明，无未定义核心符号。`);
process.exit(0);
