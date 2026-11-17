import { GAMES, type GameMode } from '@shared';
import { raceGame } from './race';
import { chemMazeGame } from './chemmaze';
import { collectGame } from './collect';
import { quizGame } from './quiz';
import { survivalGame } from './survival';
import { tailGame } from './tail';
import type { MinigameServer } from './types';

/** 구현된 미니게임 등록부. 새 게임은 파일 하나를 만들고 여기에 추가하면 된다. */
const REGISTRY: Record<string, MinigameServer> = {
  race: raceGame('race'),
  maze: raceGame('maze'),
  sumo: survivalGame('sumo', { push: true }),
  tail: tailGame('tail'),
  answer: quizGame('answer'),
  chemmaze: chemMazeGame('chemmaze'),
  spinner: survivalGame('spinner'),
  tiles: survivalGame('tiles'),
  last: survivalGame('last'),
  bomb: survivalGame('bomb'),
  dodge: survivalGame('dodge'),
  treasure: collectGame('treasure'),
};

export const getMinigame = (id: string) => REGISTRY[id];
export const playableIds = (mode: GameMode) =>
  GAMES.filter((g) => g.implemented && REGISTRY[g.id] && g.modes.includes(mode)).map((g) => g.id);

/**
 * 추첨: 직전 게임은 가능한 한 피하고, 아직 안 나온 장르와 게임을 우선한다.
 */
export function drawGame(enabled: string[], history: string[], mode: GameMode = 'play'): string {
  const pool = enabled.filter((id) => REGISTRY[id]);
  if (pool.length === 0) throw new Error('no playable minigame');
  if (pool.length === 1) return pool[0];
  const last = history[history.length - 1];
  const genreOf = (id: string) => GAMES.find((g) => g.id === id)?.genre;
  const usedGenres = new Set(history.map(genreOf));
  const count = (id: string) => history.filter((h) => h === id).length;
  const weights = pool.map((id) => {
    if (id === last) return 0;
    let w = 1 / (1 + count(id) * 2);
    if (!usedGenres.has(genreOf(id))) w *= 2.5;
    // 화학 모드: 학습형 게임이 절반쯤 나오도록 가중치를 높인다
    if (mode === 'chem' && GAMES.find((g) => g.id === id)?.chem) w *= 4;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool.find((id) => id !== last) ?? pool[0];
}
