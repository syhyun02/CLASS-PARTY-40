/** 맵 정의. 순수 데이터라서 서버(판정)와 클라이언트(예측·렌더링)가 똑같이 만든다. */
export type Vec3 = [number, number, number];

export interface Box {
  p: Vec3; // 중심
  h: Vec3; // 절반 크기
  color?: string;
}

/** 사인파로 왕복하는 박스. platform은 올라탈 수 있고, wall은 플레이어를 밀어낸다. */
export interface Mover extends Box {
  kind: 'platform' | 'wall';
  travel: Vec3; // 중심에서 한쪽 끝까지의 이동 벡터
  period: number; // 왕복 주기(초)
  phase: number; // 0~1
}

/** Y축으로 회전하는 봉. 맞으면 날아가서 넘어진다. */
export interface Sweeper {
  c: Vec3; // 회전 중심(봉의 중심 높이)
  len: number; // 중심에서 끝까지 길이
  r: number; // 봉 반지름
  speed: number; // rad/s
  phase: number; // rad
  color?: string;
}

export interface Pad extends Box {
  vy: number; // 밟으면 받는 위쪽 속도
}

export interface Checkpoint {
  zone: Box; // 이 영역에 들어오면 체크포인트 갱신
  spawn: Vec3; // 부활 위치(발바닥 기준)
}

export interface LevelDef {
  id: string;
  name: string;
  statics: Box[];
  movers: Mover[];
  sweepers: Sweeper[];
  pads: Pad[];
  /** 0번은 출발 지점. 낙하하면 마지막으로 지난 체크포인트에서 부활한다. */
  checkpoints: Checkpoint[];
  spawnCols: number;
  spawnSpacing: number;
  killY: number;
  finish?: Box;
  /** 진행도 계산용: 출발 z와 결승 z */
  track?: { z0: number; z1: number };
  sky: [string, string];
}

export function moverOffset(m: Mover, t: number): Vec3 {
  const s = Math.sin((t / m.period + m.phase) * Math.PI * 2);
  return [m.travel[0] * s, m.travel[1] * s, m.travel[2] * s];
}

export function sweeperAngle(s: Sweeper, t: number): number {
  return s.phase + s.speed * t;
}

/** slot(0~39)에 따른 격자 배치. 부활할 때도 같은 규칙으로 흩어 놓는다. */
export function spawnPoint(level: LevelDef, cp: number, slot: number): Vec3 {
  const c = level.checkpoints[Math.min(cp, level.checkpoints.length - 1)];
  const cols = level.spawnCols;
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const x = c.spawn[0] + (col - (cols - 1) / 2) * level.spawnSpacing;
  const z = c.spawn[2] - row * level.spawnSpacing;
  return [x, c.spawn[1], z];
}

export function inBox(b: Box, x: number, y: number, z: number, pad = 0): boolean {
  return (
    Math.abs(x - b.p[0]) <= b.h[0] + pad &&
    Math.abs(y - b.p[1]) <= b.h[1] + pad &&
    Math.abs(z - b.p[2]) <= b.h[2] + pad
  );
}
