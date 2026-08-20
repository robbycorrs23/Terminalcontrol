// Generated alert tones — no audio files. Two bright beeps mean "a Claude needs
// you" (a question / approval); one soft low tone means "a Claude finished its
// turn". Browsers block audio until a user gesture, so we lazily create/resume
// the AudioContext and also kick it on the first click.
//
// Whether a tone plays at all is the caller's decision (see the sound setting);
// this module only knows how to make the noise, and how loud.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext || (window as any).webkitAudioContext;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

addEventListener("click", () => audio(), { once: true });

function beep(c: AudioContext, freq: number, at: number, dur: number, gain = 0.06) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(g).connect(c.destination);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.start(at);
  osc.stop(at + dur + 0.03);
}

/**
 * @param scale 0-1 gain multiplier from the volume setting. The per-tone gains
 *   below stay the *relative* mix (the "done" tone is deliberately softer than
 *   the "needs you" pair); this scales the whole thing.
 */
export function play(kind: "question" | "done", scale = 1) {
  if (scale <= 0) return;
  const c = audio();
  const now = c.currentTime;
  if (kind === "done") {
    beep(c, 430, now, 0.26, 0.04 * scale);
  } else {
    beep(c, 880, now, 0.12, 0.06 * scale);
    beep(c, 1175, now + 0.15, 0.16, 0.06 * scale);
  }
}
