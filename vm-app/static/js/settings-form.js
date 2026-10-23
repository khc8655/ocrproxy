/**
 * settings-form.js — Schema-driven Settings UI Engine.
 * Dynamically renders settings cards, handles visibility, and serializes clean values
 * based on shared/config/settings.schema.json.
 */

(function(global) {
  'use strict';

  function getActiveHost() {
    return (global.HOST && global.HOST.kind) ? global.HOST.kind : 'vm';
  }

  // core.js declares `const state` (global lexical scope, not window.state).
  function _currentConfig() {
    try {
      if (typeof state !== 'undefined' && state && state.config) return state.config;
    } catch (_) {}
    if (global.state && global.state.config) return global.state.config;
    try { if (typeof cfg !== 'undefined' && cfg) return cfg; } catch (_) {}
    return global.cfg || {};
  }

  function getActiveRunMode() {
    const cfg = _currentConfig();
    return cfg.run_mode || 'agent';
  }

  function isFieldVisible(fld, host, mode) {
    if (fld.hidden) return false;
    if (fld.hosts && !fld.hosts.includes(host)) return false;
    if (fld.modes && !fld.modes.includes(mode)) return false;
    return true;
  }

  function renderSchemaSettings(containerId = 'schemaSettingsContainer') {
    const container = document.getElementById(containerId);
    if (!container || !global.SETTINGS_SCHEMA) return;

    const schema = global.SETTINGS_SCHEMA;
    const host = getActiveHost();
    const mode = getActiveRunMode();
    const cfg = _currentConfig();
    const s = cfg.settings || cfg || {};

    let html = '';

    (schema.groups || []).forEach(group => {
      const fields = (schema.fields || []).filter(f => f.group === group.id && isFieldVisible(f, host, mode));
      if (!fields.length) return;

      html += `
        <div class="card mb-4" id="grp_${group.id}">
          <div class="card-header font-bold text-base border-b pb-2 mb-4" style="color:var(--text-primary);border-color:var(--border);">
            ${group.title}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      `;

      fields.forEach(f => {
        let val = (s[f.key] !== undefined) ? s[f.key] : '';
        if (val === '' && f.aliases) {
          for (const al of f.aliases) {
            if (s[al] !== undefined) { val = s[al]; break; }
            if (cfg[al] !== undefined) { val = cfg[al]; break; }
          }
        }
        if (val === '' && f.default !== undefined && !f.optional) {
          val = f.default;
        }

        const inputId = `fld_${f.key}`;
        const isFullWidth = f.type === 'string' || f.key === 'proxy_api_key';
        const colClass = isFullWidth ? 'md:col-span-2' : '';

        html += `<div class="form-item ${colClass}" id="wrap_${f.key}">`;
        html += `<label class="block text-sm font-medium mb-1" style="color:var(--text-secondary);" for="${inputId}">${f.label}`;
        if (f.unit) html += ` <span style="font-weight:normal;opacity:0.75;">(${f.unit})</span>`;
        html += `</label>`;

        if (f.type === 'select') {
          html += `<select id="${inputId}" class="form-input w-full" data-key="${f.key}">`;
          (f.options || []).forEach(opt => {
            const sel = String(val) === String(opt.value) ? 'selected' : '';
            html += `<option value="${opt.value}" ${sel}>${opt.label}</option>`;
          });
          html += `</select>`;
        } else if (f.type === 'boolean') {
          const checked = (val === true || val === 'true' || val === 1) ? 'checked' : '';
          html += `
            <div style="display:flex;align-items:center;height:38px;">
              <input type="checkbox" id="${inputId}" class="form-checkbox" data-key="${f.key}" ${checked}>
              <label for="${inputId}" class="ml-2 text-sm" style="cursor:pointer;user-select:none;color:var(--text-primary);">启用此项策略</label>
            </div>
          `;
        } else {
          const typeAttr = (f.type === 'int' || f.type === 'float') ? 'number' : 'text';
          const minAttr = f.min !== undefined ? `min="${f.min}"` : '';
          const maxAttr = f.max !== undefined ? `max="${f.max}"` : '';
          const stepAttr = f.type === 'float' ? 'step="any"' : (f.type === 'int' ? 'step="1"' : '');
          const placeholderAttr = f.placeholder ? `placeholder="${f.placeholder}"` : (f.default !== undefined ? `placeholder="默认 ${f.default}${f.unit || ''}"` : '');

          html += `<input type="${typeAttr}" id="${inputId}" class="form-input w-full" data-key="${f.key}" value="${val !== undefined && val !== null ? val : ''}" ${minAttr} ${maxAttr} ${stepAttr} ${placeholderAttr}>`;
        }

        if (f.hint) {
          html += `<p class="text-xs mt-1" style="color:var(--text-muted);">${f.hint}</p>`;
        }
        html += `</div>`;
      });

      html += `
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  function collectSchemaSettings() {
    if (!global.SETTINGS_SCHEMA) return {};
    const schema = global.SETTINGS_SCHEMA;
    const host = getActiveHost();
    const mode = getActiveRunMode();
    const result = {};

    (schema.fields || []).forEach(f => {
      if (!isFieldVisible(f, host, mode)) return;
      const el = document.getElementById(`fld_${f.key}`);
      if (!el) return;

      if (f.type === 'boolean') {
        result[f.key] = el.checked;
      } else if (f.type === 'int') {
        const raw = el.value.trim();
        if (raw !== '') {
          const num = parseInt(raw, 10);
          if (!isNaN(num)) result[f.key] = num;
        }
      } else if (f.type === 'float') {
        const raw = el.value.trim();
        if (raw !== '') {
          const num = parseFloat(raw);
          if (!isNaN(num)) result[f.key] = num;
        }
      } else {
        const raw = el.value.trim();
        if (raw !== '') {
          result[f.key] = raw;
        }
      }
    });

    return result;
  }

  global.SettingsForm = {
    render: renderSchemaSettings,
    collect: collectSchemaSettings,
    isFieldVisible: isFieldVisible
  };

})(typeof window !== 'undefined' ? window : globalThis);
