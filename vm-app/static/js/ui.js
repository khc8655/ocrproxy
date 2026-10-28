/**
 * ui.js — Console v2 visual component layer.
 *
 * P0 foundation: pure HTML-string components with one token/tone vocabulary.
 * It intentionally has no framework/runtime dependency and does not touch
 * data flow, HOST capabilities, settings schema or API calls.
 */
(function (global) {
  'use strict';

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const TONES = {
    neutral: 'neutral', primary: 'primary', success: 'success',
    warning: 'warning', danger: 'danger', info: 'info',
    violet: 'violet', teal: 'teal', sky: 'sky'
  };

  function toneOf(kind, value) {
    const v = String(value || '').toLowerCase();
    if (kind === 'protocol') return v === 'messages' ? 'violet' : (v === 'responses' ? 'teal' : 'info');
    if (kind === 'origin' || kind === 'source') return v === 'vault' ? 'info' : (v === 'public' || v === '免key' ? 'sky' : 'neutral');
    if (kind === 'health' || kind === 'status') {
      if (['ok', 'success', 'normal', 'active', 'running'].includes(v)) return 'success';
      if (['rate_limited', 'warning', '429', 'timeout'].includes(v)) return 'warning';
      if (['error', 'danger', 'quota', 'needs_relogin', '403', '401', '5xx'].includes(v)) return 'danger';
      return 'neutral';
    }
    if (kind === 'mode') return v === 'kb' ? 'teal' : 'primary';
    return TONES[v] || 'neutral';
  }

  function icon(name, size) {
    const px = size || 14;
    if (typeof global.icon === 'function') return global.icon(name, px);
    return `<svg class="khc-icon" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>`;
  }

  function attrs(extra) {
    if (!extra) return '';
    return Object.entries(extra).map(([k, v]) => v === false || v === null || v === undefined ? '' : ` ${k}="${esc(v)}"`).join('');
  }

  function button(opts) {
    const o = opts || {};
    const variant = ['primary', 'secondary', 'ghost', 'danger'].includes(o.variant) ? o.variant : 'secondary';
    const size = o.size === 'sm' ? 'btn--sm' : '';
    const iconOnly = Boolean(o.iconOnly);
    const title = o.title ? esc(o.title) : '';
    const label = o.label ? esc(o.label) : '';
    const content = iconOnly ? icon(o.icon, 14) : `${o.icon ? icon(o.icon, 14) : ''}${label ? `<span>${label}</span>` : ''}`;
    const a = [
      `class="btn btn--${variant}${size ? ' ' + size : ''}${iconOnly ? ' btn--icon' : ''}"`,
      o.disabled ? 'disabled' : '',
      iconOnly ? `title="${title}" aria-label="${title}"` : '',
      attrs(o.attrs)
    ].filter(Boolean).join(' ');
    return `<button type="button" ${a}>${content}</button>`;
  }

  function badge(opts) {
    const o = opts || {};
    return `<span class="badge badge--${toneOf('tone', o.tone || 'neutral')}${o.mono ? ' mono' : ''}">${esc(o.text || '')}</span>`;
  }

  function dot(tone) {
    return `<span class="dot dot--${toneOf('tone', tone || 'neutral')}" aria-hidden="true"></span>`;
  }

  function capsule(opts) {
    const o = opts || {};
    return `<span class="capsule" title="${esc(o.label || '')}">${o.locked ? icon('lock', 12) : ''}<span class="capsule__label">${esc(o.label || '')}</span>${o.origin ? badge({ text: o.origin, tone: toneOf('origin', o.origin) }) : ''}${o.status ? badge({ text: o.status, tone: toneOf('status', o.status) }) : ''}${o.actionsHtml || ''}</span>`;
  }

  function input(opts) {
    const o = opts || {};
    const cls = `form-control${o.className ? ' ' + esc(o.className) : ''}`;
    const attrsHtml = [
      `class="${cls}"`, `type="${esc(o.type || 'text')}"`,
      o.id ? `id="${esc(o.id)}"` : '', o.value !== undefined ? `value="${esc(o.value)}"` : '',
      o.placeholder ? `placeholder="${esc(o.placeholder)}"` : '',
      o.disabled ? 'disabled' : '', attrs(o.attrs)
    ].filter(Boolean).join(' ');
    return `<input ${attrsHtml}>`;
  }

  function select(opts) {
    const o = opts || {};
    const optsHtml = (o.options || []).map(opt => {
      const value = typeof opt === 'string' ? opt : opt.value;
      const label = typeof opt === 'string' ? opt : opt.label;
      return `<option value="${esc(value)}"${String(value) === String(o.value) ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    return `<select class="form-control"${o.id ? ` id="${esc(o.id)}"` : ''}${o.disabled ? ' disabled' : ''}${attrs(o.attrs)}>${optsHtml}</select>`;
  }

  function textarea(opts) {
    const o = opts || {};
    return `<textarea class="form-control"${o.id ? ` id="${esc(o.id)}"` : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.rows ? ` rows="${Number(o.rows)}"` : ''}${attrs(o.attrs)}>${esc(o.value || '')}</textarea>`;
  }

  function switchControl(opts) {
    const o = opts || {};
    return `<label class="switch"><input type="checkbox"${o.id ? ` id="${esc(o.id)}"` : ''}${o.checked ? ' checked' : ''}${attrs(o.attrs)}><span class="switch__track" aria-hidden="true"></span><span class="switch__label">${esc(o.label || '')}</span></label>`;
  }

  function segmented(opts) {
    const o = opts || {};
    const items = (o.options || []).map(opt => {
      const value = typeof opt === 'string' ? opt : opt.value;
      const label = typeof opt === 'string' ? opt : opt.label;
      return `<button type="button" class="segmented__item${String(value) === String(o.value) ? ' is-active' : ''}" data-value="${esc(value)}" onclick="${esc(o.onclick || '')}">${esc(label)}</button>`;
    }).join('');
    return `<div class="segmented" role="group">${items}</div>`;
  }

  function card(opts) {
    const o = opts || {};
    const head = o.title || o.actionsHtml ? `<div class="card__head"><div><div class="card__title">${esc(o.title || '')}</div>${o.subtitle ? `<div class="card__sub">${esc(o.subtitle)}</div>` : ''}</div>${o.actionsHtml || ''}</div>` : '';
    return `<section class="card">${head}<div class="card__body">${o.bodyHtml || ''}</div></section>`;
  }

  function pageHeader(opts) {
    const o = opts || {};
    return `<header class="page-header"><div><h1 class="page-header__title">${esc(o.title || '')}</h1>${o.desc ? `<p class="page-header__desc">${esc(o.desc)}</p>` : ''}</div>${o.actionsHtml ? `<div class="page-header__actions">${o.actionsHtml}</div>` : ''}</header>`;
  }

  function field(opts) {
    const o = opts || {};
    return `<label class="field"><span class="field__label">${esc(o.label || '')}${o.required ? ' <b class="field__required">*</b>' : ''}</span>${o.controlHtml || ''}${o.error ? `<span class="field__error">${esc(o.error)}</span>` : (o.hint ? `<span class="field__hint">${esc(o.hint)}</span>` : '')}</label>`;
  }

  function table(opts) {
    const o = opts || {};
    const cols = (o.columns || []).map(c => `<th>${esc(c)}</th>`).join('');
    const rows = o.rowsHtml || '';
    return `<div class="table-wrap"><table class="table"><thead><tr>${cols}</tr></thead><tbody>${rows || `<tr><td colspan="${(o.columns || []).length || 1}">${empty({ title: o.empty || '暂无数据' })}</td></tr>`}</tbody></table></div>`;
  }

  function empty(opts) {
    const o = opts || {};
    return `<div class="empty">${icon(o.icon || 'layers', 20)}<div class="empty__title">${esc(o.title || '暂无数据')}</div>${o.desc ? `<div class="empty__desc">${esc(o.desc)}</div>` : ''}${o.actionHtml || ''}</div>`;
  }

  function toast(msg, type) {
    if (typeof global.toast === 'function') return global.toast(msg, type);
  }

  function openModal(id) { if (typeof global.openModal === 'function') return global.openModal(id); }
  function closeModal(id) { if (typeof global.closeModal === 'function') return global.closeModal(id); }

  function dialog(opts) {
    const o = opts || {};
    const overlay = document.createElement('div');
    overlay.className = 'ui-dialog-overlay';
    const buttons = Array.isArray(o.buttons) ? o.buttons : [];
    overlay.innerHTML = `<div class="ui-dialog" role="dialog" aria-modal="true" aria-label="${esc(o.title || '对话框')}">
      <div class="ui-dialog__head"><div class="ui-dialog__title">${esc(o.title || '')}</div><button type="button" class="ui-dialog__close" aria-label="关闭">×</button></div>
      <div class="ui-dialog__body">${o.bodyHtml || ''}</div>
      <div class="ui-dialog__foot"></div>
    </div>`;
    document.body.appendChild(overlay);
    const close = (value) => {
      overlay.remove();
      if (typeof o.onClose === 'function') o.onClose(value);
    };
    overlay.querySelector('.ui-dialog__close').addEventListener('click', () => close(undefined));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(undefined); });
    const foot = overlay.querySelector('.ui-dialog__foot');
    let controller = {
      overlay,
      el: overlay.querySelector('.ui-dialog'),
      bodyEl: overlay.querySelector('.ui-dialog__body'),
      close,
      setBody(html) { controller.bodyEl.innerHTML = html; },
      setButtons(list) {
        foot.innerHTML = '';
        (list || []).forEach(b => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `btn btn--${b.variant || 'secondary'}${b.size === 'sm' ? ' btn--sm' : ''}`;
          btn.textContent = b.label || '';
          btn.addEventListener('click', async () => {
            if (typeof b.onClick === 'function') await b.onClick(controller);
            if (b.close !== false) close(b.value);
          });
          foot.appendChild(btn);
        });
      }
    };
    controller.setButtons(buttons);
    return controller;
  }

  function confirm(opts) {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const d = dialog({
        title: o.title || '请确认',
        bodyHtml: o.desc ? `<p class="ui-dialog__desc">${esc(o.desc)}</p>` : '',
        onClose: () => done(false),
        buttons: [
          { label: o.cancelText || '取消', variant: 'secondary', onClick: () => done(false) },
          { label: o.confirmText || '确定', variant: o.danger ? 'danger' : 'primary', onClick: () => done(true) }
        ]
      });
    });
  }

  function alert(opts) {
    const o = typeof opts === 'string' ? { title: '提示', desc: opts } : (opts || {});
    return new Promise((resolve) => {
      dialog({
        title: o.title || '提示',
        bodyHtml: `<p class="ui-dialog__desc">${esc(o.desc || '')}</p>`,
        onClose: () => resolve(true),
        buttons: [{ label: o.confirmText || '知道了', variant: 'primary', onClick: () => resolve(true) }]
      });
    });
  }

  global.UI = {
    esc, icon, button, badge, dot, capsule, card, pageHeader, field, input, select, textarea, switch: switchControl, segmented, table, empty,
    toneOf, toast, openModal, closeModal, confirm, alert, dialog,
    TONE: TONES
  };
})(window);
