# KHC Web Design System — 使用手册

## 一、最小接入

复制 `colors_and_type.css` 和 `components.css` 到你的项目中：

```html
<link rel="stylesheet" href="/static/design-system/colors_and_type.css">
<link rel="stylesheet" href="/static/design-system/components.css">
```

## 二、图标系统

本规范使用 SVG Sprite。把 `icons.svg`（或参考 `base.html` 中的 `<svg>` 精灵）引入页面：

```html
<svg class="icon"><use href="#icon-refresh"/></svg>
```

图标尺寸类：
- `.icon`：默认 16×16
- `.icon-sm`：14×14
- `.icon-lg`：20×20

## 三、组件代码示例

### 按钮

```html
<button class="btn">保存配置</button>
<button class="btn secondary">取消</button>
<button class="btn danger">删除</button>
<button class="btn small">小按钮</button>
```

### 卡片

```html
<div class="card">
  <h2>卡片标题</h2>
  <p>卡片内容</p>
</div>
```

### 表格

```html
<table>
  <thead><tr><th>名称</th><th>状态</th><th>操作</th></tr></thead>
  <tbody><tr><td>项目 A</td><td><span class="badge b-running">运行中</span></td><td><a href="#">查看</a></td></tr></tbody>
</table>
```

### 页签

```html
<div class="tabs">
  <button class="tab active">信息模板</button>
  <button class="tab">邮箱验证</button>
</div>

<div class="tabs tabs-pill">
  <button class="tab active">全部</button>
  <button class="tab">运行中</button>
</div>
```

### Alert

```html
<div class="alert info">
  <svg class="icon"><use href="#icon-info"/></svg>
  <span>提示说明文案</span>
</div>
```

### 表单错误

```html
<div class="form-field has-error">
  <label>项目名称</label>
  <input type="text">
  <p class="error-msg">
    <svg class="icon icon-sm"><use href="#icon-error"/></svg>
    项目名称不能为空
  </p>
</div>
```

### 工具栏

```html
<div class="toolbar">
  <div class="toolbar-left">
    <button class="btn">新建</button>
  </div>
  <div class="toolbar-right">
    <input type="search" class="search-input" placeholder="搜索...">
    <button class="btn-icon"><svg class="icon"><use href="#icon-refresh"/></svg></button>
  </div>
</div>
```

### 弹窗

```html
<div class="modal-overlay" id="myModal" onclick="if(event.target===this)closeModal('myModal')">
  <div class="modal-dialog">
    <div class="modal-header">
      <h3>选择文件</h3>
      <button class="modal-close" onclick="closeModal('myModal')">
        <svg class="icon"><use href="#icon-close"/></svg>
      </button>
    </div>
    <div class="modal-body">内容</div>
    <div class="modal-footer">
      <button class="btn secondary" onclick="closeModal('myModal')">取消</button>
      <button class="btn">确定</button>
    </div>
  </div>
</div>

<button class="btn" onclick="openModal('myModal')">打开弹窗</button>
```

### 文件选择器

```html
<div class="file-picker" id="filePicker">
  <div class="fp-breadcrumb">小鱼易连 /</div>
  <div class="fp-list">
    <label class="fp-row">
      <svg class="icon"><use href="#icon-folder"/></svg>
      <input type="checkbox">
      <span class="fp-name">产品更新文档</span>
      <span class="fp-meta">（整个目录）</span>
    </label>
  </div>
</div>
```

## 四、JavaScript 工具

复制 `base.html` 中的以下函数到项目公共 JS：

```javascript
showToast(msg, type, duration);  // 提示信息：type = success/error/warning/info
openModal(id);                   // 打开弹窗
closeModal(id);                  // 关闭弹窗
initFilePicker(containerId);     // 初始化文件选择器计数
```

## 五、扩展方法

新增组件时：

1. 在 `components/` 添加 `{slug}.json` 组件契约
2. 在 `components.css` 添加对应 CSS（或项目自己的 CSS）
3. 在 `preview/` 添加 `component-{slug}.html` 预览
4. 更新 `ui-kits/dashboard/index.html` 展示
