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
  /**
   * 한 방향으로만 가는 탈것(호버보드). start초부터 duration초 동안 travel만큼 일정한 속도로 간다.
   * 탈것 위에서 점프해도 탈것과 함께 움직인다.
   */
  ride?: { start: number; duration: number };
}

/** Y축으로 회전하는 봉. 맞으면 날아가서 넘어진다. */
export interface Sweeper {
  c: Vec3; // 회전 중심(봉의 중심 높이)
  len: number; // 중심에서 끝까지 길이
  r: number; // 봉 반지름
  speed: number; // rad/s
  phase: number; // rad
  color?: string;
  /** 받침 없이 공중에 떠 있는 봉(호버보드 코스처럼 바닥이 지나가는 곳) */
  float?: boolean;
  /** 이 시각(초) 전에는 멈춰 있고 판정도 없다 */
  startAt?: number;
  /** 시간이 갈수록 빨라지는 정도(rad/s²)와 최고 속도 */
  accel?: number;
  maxSpeed?: number;
}

/**
 * 정해진 시각에 사라지는 발판. 일정이 맵 데이터에 들어 있어서
 * 서버와 클라이언트가 별도 통신 없이 같은 순간에 같은 발판을 없앤다.
 */
export interface Tile extends Box {
  shape: 'box' | 'disc'; // disc는 h = [반지름, 절반 높이, 반지름]
  warnAt: number; // 깜빡이기 시작하는 시각(초)
  offAt: number; // 사라지는 시각(초). 사라지지 않으면 NEVER
  /** 잠깐 사라졌다 돌아오는 구간 [시작, 끝] 목록(예고 없이 사라진다) */
  gaps?: [number, number][];
}

export function tileOn(t: Tile, time: number): boolean {
  if (time >= t.offAt) return false;
  if (t.gaps) for (const g of t.gaps) if (time >= g[0] && time < g[1]) return false;
  return true;
}
export const NEVER = 1e9;

/** 정해진 시각에 나타나 fuse초 뒤 터지는 폭탄. 반경 안에서 가려지지 않은 플레이어를 날려 보낸다. */
export interface Bomb {
  p: Vec3; // 바닥 위 위치
  at: number; // 나타나는 시각(초)
  fuse: number;
  radius: number;
}

/** 정답 발판 문제 하나. 보기 4개가 발판 4개(tiles[0..3])에 순서대로 대응한다. */
export interface QuizQ {
  at: number; // 문제가 나오는 시각(초)
  revealAt: number; // 오답 발판이 사라지는 시각
  endAt: number; // 발판이 돌아오는 시각
  text: string;
  /** 처음 몇 초만 보여 주고 가리는 내용(기억력 문제) */
  flash?: string;
  /** 색 맞히기 문제: 크게 보여 줄 낱말과 그 글자의 색 */
  word?: string;
  color?: string;
  options: string[];
  /** 정답 보기 번호. 화학 모드에서는 채점 전까지 클라이언트가 모른다(-1). */
  answer: number;
  explain?: string;
}

/** 보기 팻말을 띄울 자리: 몇 번 문제의 몇 번 보기인지 */
export interface QuizSign { p: Vec3; q: number; o: number; color: string }

/**
 * 굴러오는 공(피구공 피하기). 정해진 시각에 경기장 밖에서 출발해 곧게 굴러간다.
 * 위치가 시각만으로 정해지므로 서버와 클라이언트 예측이 같은 순간에 같은 곳에서 부딪힌다.
 */
export interface Ball {
  x: number; z: number; // 출발 위치(바닥 위)
  dx: number; dz: number; // 굴러가는 방향(단위 벡터)
  speed: number; // m/s
  r: number; // 반지름. 작은 공은 점프로 넘을 수 있다
  at: number; // 출발 시각(초)
  enter: number; // 경기장 가장자리에 닿는 시각(예고 표시용)
  end: number; // 경기장을 벗어나 사라지는 시각
  color: string;
}

export function ballPos(b: Ball, t: number): [number, number] {
  const d = (t - b.at) * b.speed;
  return [b.x + b.dx * d, b.z + b.dz * d];
}

/** 정해진 시각에 나타나는 보물. 먼저 닿은 사람이 가져간다(서버 판정). */
export interface Item {
  p: Vec3;
  at: number;
  value: number;
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
  tiles?: Tile[];
  /** 터지는 시각 순서로 정렬되어 있어야 한다 */
  bombs?: Bomb[];
  /** 출발 시각 순서로 정렬되어 있어야 한다 */
  balls?: Ball[];
  items?: Item[];
  quiz?: QuizQ[];
  signs?: QuizSign[];
  /** 팀 게임: 팀마다 출발 위치의 가운데와 바라보는 방향 */
  teamSpawns?: { x: number; z: number; yaw: number }[];
  /** 호버보드 코스의 장애물 목록(봇과 화면 안내용). gaps는 구멍 벽의 구멍 가운데 x */
  obstacles?: { kind: 'bar' | 'holes' | 'sweeper' | 'balls'; z: number; gaps?: number[]; low?: boolean }[];
  /** 눈에만 보이는 빛의 막(충돌 없음). 화학 미로의 문 */
  curtains?: Box[];
  /** 경기 시간(초). 지정하면 게임 기본 제한 시간 대신 쓴다. */
  duration?: number;
  /** true면 떨어져도 부활하지 않는다(생존 게임) */
  noRespawn?: boolean;
  /** 지정하면 격자 대신 원형으로 둘러서서 출발한다 */
  spawnRing?: number;
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
  if (m.ride) {
    const k = Math.max(0, Math.min(1, (t - m.ride.start) / m.ride.duration));
    return [m.travel[0] * k, m.travel[1] * k, m.travel[2] * k];
  }
  const s = Math.sin((t / m.period + m.phase) * Math.PI * 2);
  return [m.travel[0] * s, m.travel[1] * s, m.travel[2] * s];
}

export function sweeperAngle(s: Sweeper, t: number): number {
  const u = Math.max(0, t - (s.startAt ?? 0));
  if (!s.accel) return s.phase + s.speed * u;
  const s0 = Math.abs(s.speed), mx = s.maxSpeed ?? 99;
  const tm = Math.max(0, (mx - s0) / s.accel), uu = Math.min(u, tm);
  return s.phase + Math.sign(s.speed) * (s0 * uu + 0.5 * s.accel * uu * uu + (u > tm ? mx * (u - tm) : 0));
}

/** 현재 회전 속도(rad/s, 부호 포함). 시작 전에는 0 */
export function sweeperSpeed(s: Sweeper, t: number): number {
  if (t < (s.startAt ?? 0)) return 0;
  if (!s.accel) return s.speed;
  return Math.sign(s.speed) * Math.min(s.maxSpeed ?? 99, Math.abs(s.speed) + s.accel * (t - (s.startAt ?? 0)));
}

/** slot(0~39)에 따른 격자 배치. 부활할 때도 같은 규칙으로 흩어 놓는다. */
export function spawnPoint(level: LevelDef, cp: number, slot: number): Vec3 {
  const c = level.checkpoints[Math.min(cp, level.checkpoints.length - 1)];
  if (level.spawnRing) {
    const a = (slot / 40) * Math.PI * 2;
    return [c.spawn[0] + Math.sin(a) * level.spawnRing, c.spawn[1], c.spawn[2] + Math.cos(a) * level.spawnRing];
  }
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
