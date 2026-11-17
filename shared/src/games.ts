import type { LevelDef } from './level';
import { buildLobby } from './levels/lobby';
import { buildRace } from './levels/race';
import { buildBomb, buildDodge, buildLast, buildSpinner, buildSumo, buildTail, buildTiles, buildTreasure } from './levels/arenas';
import type { PublicQ } from './chem/bank';
import { buildChemMaze, buildMaze } from './levels/maze';
import { buildQuiz } from './levels/quiz';

export type GameMode = 'play' | 'chem';
export type Genre = 'race' | 'survival' | 'battle' | 'collect' | 'quiz';

/** 미니게임 메타데이터. 새 게임은 여기와 server/src/minigames에 하나씩 추가한다. */
export interface GameMeta {
  id: string;
  name: string;
  emoji: string;
  genre: Genre;
  modes: GameMode[];
  howTo: string;
  timeLimit: number; // 초
  implemented: boolean;
  /** 특수 행동 버튼을 쓰는 게임이면 버튼에 적을 이름 */
  action?: string;
  /** 화학 모드에서 문제은행 문제를 쓰는 학습형 게임: 문제 수와 보기 수 */
  chem?: { questions: number; options: number };
  buildLevel: (seed: number, quiz?: (PublicQ & { answer?: number; explain?: string })[]) => LevelDef;
}

export const GAMES: GameMeta[] = [
  {
    id: 'race', name: '교실 탈출 달리기', emoji: '🏃', genre: 'race', modes: ['play', 'chem'],
    howTo: '장애물을 피해 결승선까지 달려요!', timeLimit: 120, implemented: true, buildLevel: buildRace,
  },
  {
    id: 'tiles', name: '와르르 타일', emoji: '🧊', genre: 'survival', modes: ['play', 'chem'],
    howTo: '깜빡이는 발판은 곧 사라져요. 끝까지 살아남아요!', timeLimit: 78, implemented: true, buildLevel: buildTiles,
  },
  {
    id: 'spinner', name: '빙글빙글 원판', emoji: '🌀', genre: 'survival', modes: ['play', 'chem'],
    howTo: '낮은 봉은 점프! 높은 봉은 점프 금지!', timeLimit: 80, implemented: true, buildLevel: buildSpinner,
  },
  {
    id: 'sumo', name: '영차영차 씨름판', emoji: '💥', genre: 'battle', modes: ['play', 'chem'], action: '밀기',
    howTo: '밀기 버튼으로 친구를 판 밖으로 밀어내요!', timeLimit: 70, implemented: true, buildLevel: buildSumo,
  },
  {
    id: 'maze', name: '열렸다 닫혔다 미로', emoji: '🧩', genre: 'race', modes: ['play', 'chem'],
    howTo: '문이 열릴 때를 노려 출구까지 달려요!', timeLimit: 100, implemented: true, buildLevel: buildMaze,
  },
  {
    id: 'tail', name: '꼬리 지키기', emoji: '🦊', genre: 'battle', modes: ['play', 'chem'], action: '밀기',
    howTo: '꼬리 가진 친구에게 닿으면 내 것! 오래 지킬수록 점수가 올라요', timeLimit: 60, implemented: true, buildLevel: buildTail,
  },
  {
    id: 'answer', name: '정답 발판 배틀', emoji: '✅', genre: 'quiz', modes: ['play', 'chem'],
    howTo: '문제를 보고 정답 발판으로! 오답 발판은 사라져요', timeLimit: 86, implemented: true, buildLevel: buildQuiz,
    chem: { questions: 5, options: 4 },
  },
  {
    id: 'chemmaze', name: '정답의 문', emoji: '🚪', genre: 'race', modes: ['chem'],
    howTo: '정답이 적힌 문에 닿으면 열려요. 오답 문은 튕겨 내요!', timeLimit: 120, implemented: true, buildLevel: buildChemMaze,
    chem: { questions: 5, options: 3 },
  },
  {
    id: 'bomb', name: '펑펑 광장', emoji: '💣', genre: 'survival', modes: ['play', 'chem'],
    howTo: '빨간 원 밖으로 피하거나 벽 뒤에 숨어요!', timeLimit: 76, implemented: true, buildLevel: buildBomb,
  },
  {
    id: 'dodge', name: '피구공 피하기', emoji: '🏐', genre: 'survival', modes: ['play', 'chem'],
    howTo: '작은 공은 점프로 넘고, 큰 공은 옆으로 피해요!', timeLimit: 84, implemented: true, buildLevel: buildDodge,
  },
  {
    id: 'treasure', name: '반짝 보물섬', emoji: '💎', genre: 'collect', modes: ['play', 'chem'],
    howTo: '보석을 먼저 집어요. 큰 보석은 3점!', timeLimit: 60, implemented: true, buildLevel: buildTreasure,
  },
  {
    id: 'last', name: '좁아지는 섬', emoji: '👑', genre: 'survival', modes: ['play', 'chem'],
    howTo: '섬이 무너져요. 마지막 한 명이 될 때까지 버텨요!', timeLimit: 92, implemented: true, buildLevel: buildLast,
  },
];

export const getGame = (id: string) => GAMES.find((g) => g.id === id);

export function buildLevel(levelId: string, seed: number, quiz?: (PublicQ & { answer?: number; explain?: string })[] | null): LevelDef {
  if (levelId === 'lobby') return buildLobby();
  const g = getGame(levelId);
  if (!g) throw new Error(`unknown level ${levelId}`);
  return g.buildLevel(seed, quiz ?? undefined);
}

/** 순위 → 점수. 1위 100, 2위 95, 3위 90, 이후 2점씩 감소(최저 10). */
export function rankPoints(rank: number): number {
  if (rank <= 3) return 100 - (rank - 1) * 5;
  return Math.max(10, 90 - (rank - 3) * 2);
}
