/**
 * host.js — Host Platform Adapter for ocrproxy admin dashboard.
 * Bridges differences between standalone EdgeOne Worker and VM (FastAPI) environments.
 */

(function(global) {
  'use strict';

  // Detect host environment: can be explicitly set by build or auto-detected
  const isEdgeOne = (typeof global.__HOST_KIND__ !== 'undefined') 
    ? (global.__HOST_KIND__ === 'edgeone')
    : (typeof location !== 'undefined' && (
        location.pathname.startsWith('/admin') && !document.querySelector('script[src*="/static/js/"]')
      ));

  const kind = isEdgeOne ? 'edgeone' : 'vm';

  const HOST = {
    kind: kind,
    isEdgeOne: kind === 'edgeone',
    isVm: kind === 'vm',

    api: {
      config: kind === 'edgeone' ? '/api/config' : '/api/admin/config',
      login: kind === 'edgeone' ? '/api/admin/login' : '/api/admin/login',
      stats: '/api/admin/stats',
      testKey: kind === 'edgeone' ? '/api/test' : '/api/admin/test-candidate',
      testModel: kind === 'edgeone' ? '/api/test' : '/api/admin/test-agent-model',
      presetsCheck: '/api/admin/presets/check-updates',
      presetsApply: '/api/admin/presets/update-rules',
      presetsCatalog: '/api/admin/presets/catalog',
      probeModels: '/api/admin/probe-models'
    },

    capabilities: {
      runModes: kind === 'edgeone' ? ['agent'] : ['agent', 'kb'],
      logs: kind === 'vm',
      vaultClient: kind === 'vm',
      vaultHub: kind === 'edgeone',
      systemUpdate: kind === 'vm',
      accessGuides: true,
      rawEditor: true,
      keyStatus: true,
      configExportImport: true
    },

    buildTestBody: function(binding, targetModel, provName, agentModel) {
      if (kind === 'edgeone') {
        return {
          provider: binding.provider || provName,
          key: binding.key,
          model: targetModel || binding.model || binding.model_name || '',
          // Agent model name: lets /api/test store the result as this binding's last call.
          agent_model: agentModel || ''
        };
      }
      return {
        type: binding.type || 'agent',
        category: binding.category || 'agent',
        provider: binding.provider || provName,
        key: binding.key,
        model_name: targetModel || binding.model || binding.model_name || '',
        // Agent model name: the test result is stored as this binding's last call (agent:<agent_model>:<prov>:<key>).
        agent_model: agentModel || ''
      };
    },

    applyCapabilities: function() {
      // Toggle visibility based on data-cap
      document.querySelectorAll('[data-cap]').forEach(el => {
        const cap = el.getAttribute('data-cap');
        if (!cap) return;
        const negate = cap.startsWith('!');
        const capKey = negate ? cap.slice(1) : cap;
        const hasCap = !!HOST.capabilities[capKey];
        const shouldShow = negate ? !hasCap : hasCap;
        el.style.display = shouldShow ? '' : 'none';
      });
    }
  };

  global.HOST = HOST;

})(typeof window !== 'undefined' ? window : globalThis);
