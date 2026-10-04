
/** Browser speech: recognition where the browser has it (Chrome, Edge, Safari), synthesis everywhere. */

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export function canListen(): boolean {
  return typeof window !== "undefined" && Boolean((window as never as Record<string, unknown>).SpeechRecognition || (window as never as Record<string, unknown>).webkitSpeechRecognition);
}

/** Listens once; calls `onPartial` with interim text and resolves with the final transcript ("" on silence). */
export function listen(lang: string, onPartial: (t: string) => void): { done: Promise<string>; stop: () => void } {
  const W = window as never as Record<string, new () => Rec>;
  const R = W.SpeechRecognition || W.webkitSpeechRecognition;
  const rec = new R();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  let latest = "";
  const done = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      latest = (finalText + interim).trim();
      onPartial(latest);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") resolve("");
      else reject(new Error(e.error === "not-allowed" ? "Microphone access was blocked. Allow it, or type instead." : `Speech recognition failed (${e.error}).`));
    };
    rec.onend = () => resolve((finalText || latest).trim());
  });
  rec.start();
  return { done, stop: () => rec.stop() };
}

const PREFERRED = [
  /Microsoft (Aria|Jenny|Ava|Emma) Online/i,
  /Google UK English Female/i,
  /Google US English/i,
  /Samantha|Serena|Karen|Moira|Tessa/i,
  /Microsoft (Libby|Sonia|Hazel|Zira)/i,
];

let chosen: SpeechSynthesisVoice | null = null;

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  if (chosen) return chosen;
  const voices = speechSynthesis.getVoices();
  for (const re of PREFERRED) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return (chosen = v);
  }
  return (chosen = voices.find((v) => v.lang.startsWith(lang.slice(0, 2))) ?? null);
}

/** Speaks `text`; resolves when finished (or immediately if speech is unavailable or muted). */
export function speak(text: string, lang: string, muted: boolean): Promise<void> {
  if (muted || typeof speechSynthesis === "undefined" || !text) return Promise.resolve();
  speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.lang = v?.lang ?? lang;
    u.rate = 1.02;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
    // Some browsers never fire onend for long text; don't hang the UI.
    setTimeout(resolve, 2500 + text.length * 90);
  });
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
