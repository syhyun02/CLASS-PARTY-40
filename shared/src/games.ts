import type { LevelDef } from './level';
import { buildLobby } from './levels/lobby';
import { buildRace } from './levels/race';
import { buildLast, buildSpinner, buildTiles } from './levels/arenas';

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
  buildLevel: (seed: number) => LevelDef;
}

const todo = (id: string, name: string, emoji: string, genre: Genre, howTo: string): GameMeta => ({
  id, name, emoji, genre, modes: ['play', 'chem'], howTo, timeLimit: 90, implemented: false, buildLevel: buildRace,
});

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
  todo('sumo', '밀어내기 아레나', '💥', 'battle', '친구를 경기장 밖으로 밀어내요'),
  todo('maze', '움직이는 미로', '🧩', 'race', '바뀌는 미로에서 출구를 찾아요'),
  todo('tail', '꼬리 지키기', '🦊', 'battle', '꼬리를 빼앗고 끝까지 지켜요'),
  todo('answer', '정답 발판 배틀', '✅', 'quiz', '정답 발판 위로 달려가요'),
  todo('bomb', '폭탄 피하기', '💣', 'survival', '폭발을 피해 살아남아요'),
  todo('treasure', '보물 쟁탈전', '💎', 'collect', '보물을 가장 많이 모아요'),
  {
    id: 'last', name: '좁아지는 섬', emoji: '👑', genre: 'survival', modes: ['play', 'chem'],
    howTo: '섬이 무너져요. 마지막 한 명이 될 때까지 버텨요!', timeLimit: 92, implemented: true, buildLevel: buildLast,
  },
];

export const getGame = (id: string) => GAMES.find((g) => g.id === id);

export function buildLevel(levelId: string, seed: number): LevelDef {
  if (levelId === 'lobby') return buildLobby();
  const g = getGame(levelId);
  if (!g) throw new Error(`unknown level ${levelId}`);
  return g.buildLevel(seed);
}

/** 순위 → 점수. 1위 100, 2위 95, 3위 90, 이후 2점씩 감소(최저 10). */
export function rankPoints(rank: number): number {
  if (rank <= 3) return 100 - (rank - 1) * 5;
  return Math.max(10, 90 - (rank - 3) * 2);
}
