// src/update.js - detect a newer deployed build and refresh cached modules.
// GitHub Pages serves files with a 10 minute cache; without this the phone
// can keep running an old build after a push.
import { VERSION } from './version.js';

export { VERSION };

export async function checkForUpdate(log = () => {}) {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (!res.ok) return false;
    const j = await res.json();
    if (!j.v || j.v === VERSION) return false;
    let tried = null;
    try {
      tried = sessionStorage.getItem('update:tried');
    } catch {
      /* private mode */
    }
    if (tried === j.v) {
      log(`update ${j.v} still not active after refresh (running ${VERSION})`);
      return false;
    }
    try {
      sessionStorage.setItem('update:tried', j.v);
    } catch {
      /* ignore */
    }
    log(`new build ${j.v} (running ${VERSION}); refreshing ${(j.files || []).length} files`);
    await Promise.all((j.files || []).map((f) => fetch(f, { cache: 'reload' }).catch(() => null)));
    location.reload();
    return true;
  } catch (e) {
    log(`update check failed: ${e.message}`);
    return false;
  }
}
