/** 서버·클라이언트가 함께 쓰는 상수. 값을 바꾸면 양쪽이 같이 바뀐다. */
export const TICK_RATE = 30; // 서버 시뮬레이션 Hz
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2; // 2틱마다 스냅샷 = 15Hz
export const MAX_PLAYERS = 40;

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HALF_HEIGHT = 0.2; // 캡슐 원통부 절반 높이 (전체 키 1.2m)
export const PLAYER_CENTER_Y = PLAYER_RADIUS + PLAYER_HALF_HEIGHT; // 발바닥에서 중심까지

export const MOVE_SPEED = 6.2;
export const GROUND_ACCEL = 55;
export const AIR_ACCEL = 22;
export const GRAVITY = -30;
export const JUMP_VELOCITY = 10;
export const COYOTE_TICKS = 4;
export const JUMP_BUFFER_TICKS = 4;
export const STUN_TICKS = 24; // 넘어져 있는 시간(0.8초)

export const PLAYER_COLORS = [
  '#ff6b8b', '#ff9f43', '#ffd93d', '#6bcb77', '#4dd4c6', '#4d96ff',
  '#9b72f2', '#f77fd1', '#a3e635', '#fb7185', '#38bdf8', '#f5f5f4',
] as const;

export const SNAP_POS_SCALE = 50; // int16 위치 양자화(2cm)
