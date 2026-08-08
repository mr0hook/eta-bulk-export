// Locks — Durable Object for atomic RIN ownership and rate limiting.
// Optional binding: every caller falls back to best-effort KV when env.LOCKS is absent.
// Extracted verbatim from the pre-split worker.js (A0). Bodies are unchanged — only the module
// header, imports and exports below are new.
import { DurableObject } from 'cloudflare:workers';

// Strongly-consistent, single-threaded coordination. One instance per RIN ("rin:<rin>") gives an atomic
// first-writer-wins ownership claim (KV has no compare-and-set); one instance per IP ("rl:<ip>") gives an
// atomic rate-limit counter.
export class Locks extends DurableObject {
  // Adopt any ownership that was recorded in KV before this DO existed (rinowner:<rin>), so migrating from the
  // KV-only phase to the DO doesn't strand pre-existing claims (which would let a second account re-claim them).
  async #seed(rin) {
    let owner = await this.ctx.storage.get('owner');
    if (owner === undefined && rin) {
      const legacy = await this.env.LEADS.get('rinowner:' + rin);
      if (legacy) { await this.ctx.storage.put('owner', legacy); owner = legacy; }
    }
    return owner;
  }
  async claimRin(deviceId, rin) {                              // atomic: first device to claim a RIN wins
    // blockConcurrencyWhile keeps seed→check→write a single critical section EVEN across the external KV read
    // inside #seed — the DO input gate only auto-serializes across its own storage ops, so a bare KV await would
    // reopen the gate and let two concurrent first-claims both win.
    return this.ctx.blockConcurrencyWhile(async () => {
      const owner = await this.#seed(rin);
      if (owner && owner !== deviceId) return { ok: false, owner };
      if (!owner) await this.ctx.storage.put('owner', deviceId);
      return { ok: true, owner: deviceId };
    });
  }
  async releaseRin(deviceId, rin) {                            // release only if we hold it (or it's unclaimed)
    return this.ctx.blockConcurrencyWhile(async () => {
      const owner = await this.#seed(rin);
      if (!deviceId || owner === undefined || owner === deviceId) {
        await this.ctx.storage.delete('owner');
        if (rin) { try { await this.env.LEADS.delete('rinowner:' + rin); } catch {} }   // also clear any legacy KV claim
        return { ok: true, released: true };
      }
      return { ok: true, released: false };
    });
  }
  async getOwner(rin) { return (await this.#seed(rin)) || null; }
  async rateHit(limit, windowMs) {                             // atomic fixed-window counter (self-cleans via alarm)
    const now = Date.now();
    let w = await this.ctx.storage.get('w');
    if (!w || (now - w.start) >= windowMs) w = { start: now, n: 0, win: windowMs };
    w.n += 1;
    await this.ctx.storage.put('w', w);
    await this.ctx.storage.setAlarm(w.start + w.win + 1000);
    return { ok: w.n <= limit, n: w.n };
  }
  async alarm() {                                              // rate-limit DOs only (rin: DOs never set an alarm)
    const w = await this.ctx.storage.get('w');
    if (!w) return;                                            // guard: never touch an ownership-only DO
    if ((Date.now() - w.start) >= (w.win || 3600000)) await this.ctx.storage.delete('w');
    else await this.ctx.storage.setAlarm(w.start + (w.win || 3600000) + 1000);
  }
}
