// Lightweight audio + haptic feedback for supervisor scans.
// Uses WebAudio (no asset download) + navigator.vibrate (Android). iOS Safari
// silently ignores vibrate; the beep still plays there.

let _ctx = null;
function ctx() {
  if (_ctx) return _ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  _ctx = new AC();
  return _ctx;
}

/** Prime the AudioContext on the first user gesture (some browsers need this). */
export function primeAudio() {
  const c = ctx();
  if (c && c.state === "suspended") { c.resume().catch(() => {}); }
}

function play(freq, durationMs, type = "sine", gainMax = 0.22, delayMs = 0) {
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") { c.resume().catch(() => {}); }
  const start = c.currentTime + delayMs / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(c.destination);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gainMax, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000);
  osc.start(start);
  osc.stop(start + durationMs / 1000 + 0.02);
}

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* ignored */ }
}

/** Success beep + short haptic — for a +1 box scan. */
export function beepSuccess() {
  play(880, 130, "square", 0.22);           // cheerful high beep
  vibrate(70);
}

/** Two-tone confirmation — for clock-in. */
export function beepClockIn() {
  play(660, 100, "sine", 0.22, 0);
  play(990, 130, "sine", 0.22, 120);
  vibrate([60, 40, 90]);
}

/** Descending confirmation — for clock-out. */
export function beepClockOut() {
  play(990, 100, "sine", 0.22, 0);
  play(660, 140, "sine", 0.22, 120);
  vibrate([80, 40, 120]);
}

/** Low buzz + double haptic — for rejected scans. */
export function beepError() {
  play(180, 220, "sawtooth", 0.28, 0);
  vibrate([120, 80, 120]);
}
