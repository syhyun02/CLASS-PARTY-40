import type { LevelDef } from '../level';

export const PODIUM_Z = 12.5;
/** 시상대 세 칸: 1위(가운데, 가장 높음), 2위(왼쪽), 3위(오른쪽). 카메라가 +z를 볼 때 +x가 화면 왼쪽이다. */
export const PODIUM = [
  { x: 0, h: 0.8, color: '#ffd43b' },
  { x: 2.6, h: 0.55, color: '#ced4da' },
  { x: -2.6, h: 0.35, color: '#ffa94d' },
];

/** 대기실: 떨어져도 바로 부활하는 놀이터. 조작을 미리 익히는 곳. */
export function buildLobby(): LevelDef {
  return {
    id: 'lobby',
    name: '대기실',
    statics: [
      { p: [0, -0.5, 0], h: [16, 0.5, 16], color: '#5cc8ff' },
      { p: [0, -0.45, 0], h: [6, 0.5, 6], color: '#ff8fc7' },
      // 계단과 전망대
      { p: [-10, 0.25, -9], h: [2, 0.25, 2], color: '#ffb347' },
      { p: [-10, 0.75, -12], h: [2, 0.75, 1.5], color: '#ffd43b' },
      { p: [-6.5, 1.25, -12], h: [1.5, 1.25, 1.5], color: '#5fe0a8' },
      // 낮은 담장 놀이터
      { p: [9, 0.3, 8], h: [0.3, 0.3, 3], color: '#9775fa' },
      { p: [12, 0.3, 8], h: [0.3, 0.3, 3], color: '#9775fa' },
      { p: [10.5, 0.3, 11], h: [1.8, 0.3, 0.3], color: '#f783ac' },
      // 시상대(시상식 때 1~3위가 올라간다)
      ...PODIUM.map((b) => ({ p: [b.x, b.h, PODIUM_Z] as [number, number, number], h: [1.25, b.h, 1.25] as [number, number, number], color: b.color })),
    ],
    movers: [
      { kind: 'platform', p: [10, 0.6, -9], h: [1.6, 0.2, 1.6], travel: [0, 0, 4], period: 6, phase: 0, color: '#3bc9db' },
    ],
    sweepers: [{ c: [-8, 0.45, 8], len: 4.2, r: 0.28, speed: 1.4, phase: 0, color: '#ff4f8b' }],
    pads: [{ p: [12, 0.06, 1], h: [1.2, 0.06, 1.2], vy: 15 }],
    checkpoints: [{ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 3] }],
    spawnCols: 8,
    spawnSpacing: 1.3,
    killY: -12,
    sky: ['#3fb0ff', '#ffe3f4'],
  };
}
