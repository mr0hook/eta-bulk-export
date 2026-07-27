// Shared localStorage JSON helpers (etaBulk_ namespace). Import-safe without a localStorage global
// (node tests): every access is try/caught. Registration creds, theme, language, run-log, stats and
// dismissed-message ids all live behind these three.
const LS = 'etaBulk_';
export const lsGet = (k) => { try { const v = localStorage.getItem(LS + k); return v == null ? undefined : JSON.parse(v); } catch { return undefined; } };
export const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } };
export const lsDel = (k) => { try { localStorage.removeItem(LS + k); } catch {} };
