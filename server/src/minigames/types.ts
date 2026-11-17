import type { LevelDef, PlayerInput, PlayerState, RoundRow, SnapPlayer } from '@shared';

/** 미니게임이 방에서 볼 수 있는 플레이어 */
export interface GamePlayer {
  id: number;
  name: string;
  color: string;
  connected: boolean;
  state: PlayerState;
  /** 가장 최근에 처리한 입력 */
  input: PlayerInput;
  /** 마지막으로 밀치기를 쓴 틱(동작 표시용) */
  pushAt: number;
  /** 완주·탈락 등으로 이번 라운드가 끝난 경우 true */
  done: boolean;
  place: number | null;
  /** 탈락해서 더 이상 경기장에 없음(관전) */
  out: boolean;
  /** 팀 게임의 팀 번호(-1: 없음) */
  team: number;
}

export interface GameCtx {
  level: LevelDef;
  /** 이번 라운드 참가자(도중 입장한 관전자는 제외) */
  players: GamePlayer[];
  /** 게임 시작 후 지난 틱 */
  elapsed(): number;
  /** 남은 시간을 줄인다(틱) */
  shortenTo(ticksLeft: number): void;
  ticksLeft(): number;
  /** 방의 현재 틱 */
  tick(): number;
  /** 맵 시간(초). 맵 데이터의 일정(at, offAt 등)과 같은 기준이다. */
  levelTime(): number;
  /** 게임별 실시간 상태를 전원에게 보낸다(자주 불러도 서버가 묶어서 보낸다) */
  publish(state: unknown): void;
  /** 스냅샷에 캐릭터와 함께 보낼 물체(번호는 PROP_ID_BASE 이상) */
  setProps(list: SnapPlayer[]): void;
  /** 캐릭터를 벽을 뚫지 않게 살짝 민다 */
  nudge(state: PlayerState, dx: number, dz: number): void;
  /** 한 학생에게만 알린다 */
  tell(id: number, msg: Record<string, unknown>): void;
  /** 이번 맵의 시드 */
  seed: number;
  /** 플레이어 정보가 바뀌었음을 알린다 → 방 상태 재전송 */
  touch(): void;
}

export interface RoundOutcome {
  id: number;
  rank: number;
  points: number;
  detail: string;
}

/**
 * 모든 미니게임이 구현하는 공통 인터페이스.
 * 이동·충돌은 SimWorld가 처리하고, 여기서는 승패 규칙만 다룬다.
 */
export interface MinigameRuntime {
  /** 플레이어 이동이 끝난 뒤 틱마다 호출 */
  onTick(): void;
  /** 이 플레이어가 지금 조작 가능한가 */
  canMove(p: GamePlayer): boolean;
  /** 제한 시간 전에 끝낼 조건 */
  isOver(): boolean;
  /** 최종 순위와 점수 */
  outcome(): RoundOutcome[];
}

export interface MinigameServer {
  id: string;
  create(ctx: GameCtx): MinigameRuntime;
}

export type { RoundRow };
