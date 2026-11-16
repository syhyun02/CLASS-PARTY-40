import { COUNTDOWN_SEC } from '../constants';
import type { PublicQ } from '../chem/bank';
import { NEVER, type LevelDef, type QuizQ, type Tile } from '../level';
import { rng } from './race';

/** 발판 4개의 색 이름과 색(보기 순서와 같다) */
export const QUIZ_PADS = [
  { name: '빨강', color: '#ff6b6b' },
  { name: '파랑', color: '#4dabf7' },
  { name: '노랑', color: '#ffd43b' },
  { name: '초록', color: '#51cf66' },
];
const PAD_POS: [number, number][] = [[-5.7, 5.7], [5.7, 5.7], [-5.7, -5.7], [5.7, -5.7]];
export const QUIZ_HALF = 5.5;

type Gen = (r: () => number) => Omit<QuizQ, 'at' | 'revealAt' | 'endAt'>;
const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)];
/** 섞기. 난수 비교 함수로 정렬하면 브라우저마다 결과가 달라 서버와 맵이 어긋나므로 직접 섞는다. */
function shuffle<T>(r: () => number, a: T[]): T[] {
  const o = [...a];
  for (let i = o.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [o[i], o[k]] = [o[k], o[i]]; }
  return o;
}
/** 정답과 오답 3개를 섞어 보기와 정답 번호를 만든다 */
function options(r: () => number, right: string, wrong: string[]) {
  const o = [right, ...wrong.slice(0, 3)];
  for (let i = 3; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [o[i], o[k]] = [o[k], o[i]]; }
  return { options: o, answer: o.indexOf(right) };
}
const near = (r: () => number, n: number) => {
  const s = new Set<number>();
  while (s.size < 3) { const v = n + Math.floor(r() * 21) - 10; if (v !== n && v >= 0) s.add(v); }
  return [...s].map(String);
};

/** 놀이 모드 문제 생성기: 암산, 색 글자, 큰 수, 기억력, 개수 세기 */
const GENS: Gen[] = [
  (r) => { // 암산
    const a = 11 + Math.floor(r() * 40), b = 6 + Math.floor(r() * 30), plus = r() < 0.6;
    // 뺄셈은 (a+b) − b 꼴로 내서 음수가 나오지 않게 한다
    return plus ? { text: `${a} + ${b} = ?`, ...options(r, String(a + b), near(r, a + b)) }
      : { text: `${a + b} − ${b} = ?`, ...options(r, String(a), near(r, a)) };
  },
  (r) => { // 색 글자(글자 뜻이 아니라 글자의 색을 고른다)
    const ink = Math.floor(r() * 4);
    let word = Math.floor(r() * 4);
    if (word === ink) word = (word + 1) % 4;
    return { text: '이 글자는 무슨 "색"으로 쓰여 있을까?', word: QUIZ_PADS[word].name, color: QUIZ_PADS[ink].color, options: QUIZ_PADS.map((p) => p.name), answer: ink };
  },
  (r) => { // 가장 큰 수
    const s = new Set<number>();
    while (s.size < 4) s.add(300 + Math.floor(r() * 600));
    const a = [...s], max = Math.max(...a);
    return { text: '가장 큰 수는?', options: a.map(String), answer: a.indexOf(max) };
  },
  (r) => { // 기억력: 잠깐 보여 준 순서에서 몇 번째
    const pool = ['🍎', '🍌', '🍇', '🍊', '🍓', '🥝'];
    const seq = shuffle(r, pool).slice(0, 4);
    const k = Math.floor(r() * 4);
    return { text: `${k + 1}번째 과일은?`, flash: seq.join('  '), ...options(r, seq[k], seq.filter((_, i) => i !== k)) };
  },
  (r) => { // 개수 세기
    const target = pick(r, ['⭐', '🌙', '💧']);
    const others = ['⭐', '🌙', '💧', '🔥'].filter((x) => x !== target);
    const n = 4 + Math.floor(r() * 5);
    const all = shuffle(r, [...Array(n).fill(target), ...Array.from({ length: 7 + Math.floor(r() * 4) }, () => pick(r, others))]);
    return { text: `${target} 는 모두 몇 개?\n${all.join(' ')}`, ...options(r, String(n), [n - 1, n + 1, n + 2].map(String)) };
  },
];

/**
 * 정답 발판 배틀
 * 문제가 나오면 정답 보기의 발판으로 달려간다. 시간이 되면 오답 발판 3개가 잠깐 사라진다.
 * 가운데 섬은 사라지지 않지만 거기 서 있으면 정답으로 치지 않는다. 틀려도 다음 문제에 다시 참가한다.
 */
export function buildQuiz(seed: number, ext?: (PublicQ & { answer?: number; explain?: string })[]): LevelDef {
  const r = rng(seed);
  const tiles: Tile[] = PAD_POS.map(([x, z], i) => ({
    shape: 'box', p: [x, -0.4, z], h: [QUIZ_HALF, 0.4, QUIZ_HALF], color: QUIZ_PADS[i].color, warnAt: NEVER, offAt: NEVER, gaps: [],
  }));
  tiles.push({ shape: 'disc', p: [0, -0.46, 0], h: [2.4, 0.5, 2.4], color: '#ffffff', warnAt: NEVER, offAt: NEVER });
  const quiz: QuizQ[] = [];
  let t = COUNTDOWN_SEC + 1;
  const add = (q: Omit<QuizQ, 'at' | 'revealAt' | 'endAt'>, think: number, rest: number) => {
    const at = t, revealAt = t + think, endAt = revealAt + 3;
    quiz.push({ ...q, at, revealAt, endAt });
    // 정답을 아는 쪽(서버, 놀이 모드)은 오답 발판이 사라질 구간을 미리 넣어 둔다
    if (q.answer >= 0) tiles.forEach((tile, i) => { if (i < 4 && i !== q.answer) tile.gaps!.push([revealAt, endAt]); });
    t = endAt + rest;
  };
  if (ext?.length) {
    // 화학 모드: 읽고 생각할 시간을 넉넉히, 채점 뒤에는 해설을 읽을 시간을 준다
    for (const e of ext) add({ text: e.text, options: e.options, answer: e.answer ?? -1, explain: e.explain }, 15, 4.5);
  } else {
    for (const g of shuffle(r, [0, 1, 2, 3, 4, Math.floor(r() * 5)])) add(GENS[g](r), 9, 1.4);
  }
  return {
    id: 'answer', name: '정답 발판 배틀',
    statics: [], movers: [], sweepers: [], pads: [], tiles, quiz,
    signs: quiz.flatMap((_, qi) => PAD_POS.map(([x, z], o) => ({ p: [x, 3.1, z] as [number, number, number], q: qi, o, color: QUIZ_PADS[o].color }))),
    duration: t - COUNTDOWN_SEC + 0.5,
    checkpoints: [{ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0.05, 0] }],
    spawnCols: 8, spawnSpacing: 1.5, spawnRing: 1.9, killY: -7,
    sky: ['#3fb0ff', '#ffe3f4'],
  };
}

/** (x, z)가 몇 번 발판 위인지. 가운데 섬이나 발판 밖이면 -1 */
export function quizPadAt(x: number, z: number): number {
  if (Math.hypot(x, z) < 2.4) return -1;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(x - PAD_POS[i][0]) <= QUIZ_HALF && Math.abs(z - PAD_POS[i][1]) <= QUIZ_HALF) return i;
  }
  return -1;
}
export const QUIZ_PAD_POS = PAD_POS;
