import { useStore } from './store';

/**
 * 효과음과 배경음악. 음원 파일 없이 Web Audio로 직접 합성한다(용량 0, 오프라인에서도 동작).
 * 브라우저 정책상 소리는 사용자가 화면을 한 번 누른 뒤에만 나므로, 첫 터치·클릭에서 unlock()을 부른다.
 */
type Name =
  | 'click' | 'jump' | 'bonk' | 'beep' | 'go' | 'tick' | 'reveal' | 'coin' | 'bigcoin' | 'boom'
  | 'push' | 'right' | 'wrong' | 'out' | 'finish' | 'fanfare' | 'tail' | 'warn';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicMode: 'off' | 'calm' | 'play' = 'off';

const load = (k: string, def: boolean) => { try { const v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch { return def; } };
const save = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* 무시 */ } };
export const soundPrefs = { sfx: load('cp40:sfx', true), music: load('cp40:music', true) };

export function setSfx(on: boolean) { soundPrefs.sfx = on; save('cp40:sfx', on); useStore.setState({ soundTick: Date.now() }); }
export function setMusicPref(on: boolean) { soundPrefs.music = on; save('cp40:music', on); applyMusic(); useStore.setState({ soundTick: Date.now() }); }

/** 학생 기기는 교사가 방 설정에서 소리를 끄면 조용해진다. */
function allowed(): boolean {
  const st = useStore.getState();
  if (st.screen === 'play' && st.room && st.room.config.studentSound === false) return false;
  return true;
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function tone(freq: number, dur: number, opt: { type?: OscillatorType; vol?: number; to?: number; at?: number; dest?: AudioNode } = {}) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + (opt.at ?? 0);
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = opt.type ?? 'triangle';
  o.frequency.setValueAtTime(freq, t);
  if (opt.to) o.frequency.exponentialRampToValueAtTime(opt.to, t + dur);
  const v = opt.vol ?? 0.3;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(opt.dest ?? master);
  o.start(t); o.stop(t + dur + 0.03);
}

function noise(dur: number, vol: number, freq: number, at = 0) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + at;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.2), t + dur);
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t);
}

const N = (semi: number) => 261.63 * Math.pow(2, semi / 12); // 가운데 도에서 반음 수

export function play(name: Name, vol = 1) {
  if (!ctx || !soundPrefs.sfx || !allowed() || document.visibilityState !== 'visible') return;
  const v = (x: number) => x * vol;
  switch (name) {
    case 'click': tone(660, 0.05, { vol: v(0.12), type: 'square' }); break;
    case 'jump': tone(330, 0.16, { to: 720, vol: v(0.2) }); break;
    case 'bonk': tone(180, 0.22, { to: 70, vol: v(0.35), type: 'square' }); noise(0.12, v(0.25), 900); break;
    case 'beep': tone(N(12), 0.14, { vol: v(0.3), type: 'square' }); break;
    case 'go': tone(N(19), 0.4, { vol: v(0.35), type: 'square' }); tone(N(24), 0.4, { vol: v(0.2), at: 0.02 }); break;
    case 'tick': tone(900, 0.03, { vol: v(0.1), type: 'square' }); break;
    case 'reveal': [0, 4, 7, 12].forEach((s, i) => tone(N(s + 12), 0.22, { vol: v(0.25), at: i * 0.07 })); break;
    case 'coin': tone(N(19), 0.08, { vol: v(0.22), type: 'square' }); tone(N(24), 0.16, { vol: v(0.22), type: 'square', at: 0.07 }); break;
    case 'bigcoin': [19, 24, 28].forEach((s, i) => tone(N(s), 0.14, { vol: v(0.24), type: 'square', at: i * 0.06 })); break;
    case 'boom': noise(0.5, v(0.6), 1400); tone(90, 0.4, { to: 35, vol: v(0.4), type: 'sine' }); break;
    case 'push': noise(0.1, v(0.3), 2200); tone(240, 0.1, { to: 140, vol: v(0.2) }); break;
    case 'right': [12, 16, 19, 24].forEach((s, i) => tone(N(s), 0.18, { vol: v(0.26), at: i * 0.08 })); break;
    case 'wrong': tone(N(3), 0.2, { vol: v(0.28), type: 'sawtooth' }); tone(N(-2), 0.32, { vol: v(0.28), type: 'sawtooth', at: 0.16 }); break;
    case 'out': tone(520, 0.5, { to: 110, vol: v(0.3), type: 'sawtooth' }); break;
    case 'finish': [12, 16, 19, 24, 28].forEach((s, i) => tone(N(s), 0.25, { vol: v(0.28), at: i * 0.09, type: 'square' })); break;
    case 'fanfare': [[0, 12], [0.16, 12], [0.32, 12], [0.48, 16], [0.8, 14], [0.96, 16], [1.12, 19]].forEach(([at, s]) => { tone(N(s), 0.3, { vol: v(0.3), at, type: 'square' }); tone(N(s - 12), 0.3, { vol: v(0.18), at }); }); break;
    case 'tail': tone(N(16), 0.1, { vol: v(0.25) }); tone(N(21), 0.18, { vol: v(0.25), at: 0.08 }); break;
    case 'warn': tone(N(9), 0.08, { vol: v(0.16), type: 'square' }); break;
  }
}

// ---- 배경음악: 짧은 선율을 반복하는 가벼운 반주. 교사 화면(프로젝터)에서만 기본으로 튼다. ----
const CHORDS = [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]]; // C Am F G
const MELODY = [12, 16, 19, 16, 21, 19, 16, 14, 12, 14, 16, 19, 17, 16, 14, 12];
let step = 0;

function musicStep() {
  if (!ctx || !musicGain || musicMode === 'off') return;
  const fast = musicMode === 'play';
  const bar = Math.floor(step / 8) % 4, beat = step % 8;
  const ch = CHORDS[bar];
  if (beat % 4 === 0) tone(N(ch[0] - 24), 0.3, { vol: 0.22, type: 'triangle', dest: musicGain });
  if (beat % 2 === 1) tone(N(ch[(beat >> 1) % 3] - 12), 0.14, { vol: 0.08, type: 'square', dest: musicGain });
  if (fast || beat % 2 === 0) {
    const m = MELODY[(step >> (fast ? 0 : 1)) % MELODY.length] + (bar === 1 ? -3 : bar === 2 ? 5 - 12 + 7 : 0);
    if ((step * 7) % 5 !== 0) tone(N(m), fast ? 0.14 : 0.26, { vol: 0.1, type: 'triangle', dest: musicGain });
  }
  step++;
}

function applyMusic() {
  if (!ctx || !musicGain) return;
  const on = musicMode !== 'off' && soundPrefs.music && allowed();
  musicGain.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.3);
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  if (on) musicTimer = setInterval(musicStep, musicMode === 'play' ? 150 : 210);
}

export function setMusic(mode: 'off' | 'calm' | 'play') {
  if (mode === musicMode) return;
  musicMode = mode;
  applyMusic();
}

/** 방 상태·내 상태의 변화를 지켜보다가 알맞은 효과음을 낸다. 한 번만 호출한다. */
export function initSoundEvents() {
  const once = () => unlock();
  window.addEventListener('pointerdown', once, { passive: true });
  window.addEventListener('keydown', once);
  window.addEventListener('click', (e) => { if ((e.target as HTMLElement)?.closest?.('button')) play('click'); }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') unlock(); });

  useStore.subscribe((s, p) => {
    const room = s.room, prev = p.room;
    if (!room) { setMusic('off'); return; }
    // 배경음악은 교사 화면에서만: 대기·결과는 잔잔하게, 경기 중에는 빠르게
    if (s.screen === 'host') setMusic(room.paused ? 'off' : room.phase === 'playing' || room.phase === 'countdown' ? 'play' : 'calm');
    else setMusic('off');
    if (prev && room.phase !== prev.phase) {
      if (room.phase === 'result') play('finish');
      if (room.phase === 'final') play('fanfare');
      if (room.phase === 'playing') play('go');
    }
    if (prev?.config.studentSound !== room.config.studentSound) applyMusic();
    const me = room.players.find((x) => x.id === s.myId), was = prev?.players.find((x) => x.id === s.myId);
    if (me && was && room.phase === 'playing') {
      if (me.out && !was.out) play('out');
      else if (me.place !== null && was.place === null && !me.out) play('finish');
    }
    // 게임별 상태
    const g = s.game, pg = p.game;
    if (g !== pg && g && s.myId !== null) {
      const mine = g.scores?.find((x) => x[0] === s.myId)?.[1] ?? 0, before = pg?.scores?.find((x) => x[0] === s.myId)?.[1] ?? 0;
      if (g.taken && mine > before) play(mine - before >= 3 ? 'bigcoin' : 'coin');
      if (g.tails) { const has = g.tails.includes(s.myId), had = pg?.tails?.includes(s.myId) ?? false; if (has !== had) play(has ? 'tail' : 'wrong'); }
      if (g.quiz && g.quiz.index !== pg?.quiz?.index) play(g.quiz.correct.includes(s.myId) ? 'right' : 'wrong');
    }
    if (g !== pg && g?.quiz && s.myId === null && g.quiz.index !== pg?.quiz?.index) play('reveal');
    if (s.mine !== p.mine) {
      if (s.mine.passed > p.mine.passed) play('right');
      else if (s.mine.wrong.length > p.mine.wrong.length) play('wrong');
    }
  });
}
