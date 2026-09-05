/**
 * api/admin/config.js — Re-exports /api/config for full cross-platform route parity.
 */
export {
  onRequestGet,
  onRequestPost,
  onRequestPut,
  onRequestDelete,
} from '../config.js';
