// Generated alert tones — no audio files. Two bright beeps mean "a Claude needs
// you" (a question / approval); one soft low tone means "a Claude finished its
// turn". Browsers block audio until a user gesture, so we lazily create/resume
// the AudioContext and also kick it on the first click.

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

export function play(kind: "question" | "done") {
  const c = audio();
  const now = c.currentTime;
  if (kind === "done") {
    beep(c, 430, now, 0.26, 0.04);
  } else {
    beep(c, 880, now, 0.12);
    beep(c, 1175, now + 0.15, 0.16);
  }
}
