// Near-silent AudioContext tone started on the Start gesture — stops Chrome from
// throttling setTimeout in a backgrounded tab. (Our xlsx build has no rAF dependency.)
let ctx = null, osc = null;
export function start() {
  try {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC(); osc = ctx.createOscillator();
    const g = ctx.createGain(); g.gain.value = 0.0008; osc.frequency.value = 20;
    osc.connect(g); g.connect(ctx.destination); osc.start(); ctx.resume?.();
  } catch {}
}
export function stop() { try { osc?.stop(); ctx?.close(); } catch {} osc = null; ctx = null; }
