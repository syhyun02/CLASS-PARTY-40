import type { Box, LevelDef } from '../level';

export const TEAM_NAMES = ['빨강', '파랑', '노랑', '초록'];
export const TEAM_COLORS = ['#ff4d4d', '#3d8bff', '#ffc53d', '#33c26b'];
/**
 * 팀 공 넣기 경기장: 한 변 30m 정사각형, 네 변 가운데에 팀 골대가 있다.
 * 골대 방향: 0팀 +z, 1팀 +x, 2팀 −z, 3팀 −x
 */
export const TEAMBALL = { half: 15, goalHalf: 3.6, goalDepth: 3.5, wallH: 2.6, ballR: 1.25, balls: 3 };
export const GOAL_DIRS: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];

export function buildTeamBall(_seed: number): LevelDef {
  const { half: H, goalHalf: G, goalDepth: D, wallH } = TEAMBALL;
  const statics: Box[] = [];
  statics.push({ p: [0, -0.5, 0], h: [H, 0.5, H], color: '#7fdca4' });
  GOAL_DIRS.forEach(([dx, dz], team) => {
    const along = (a: number, b: number, y: number, hy: number, thick: number, out: number, color: string) => {
      // 변을 따라 a~b 구간의 벽(out: 경기장 가장자리에서 바깥으로 떨어진 거리)
      const c = (a + b) / 2, len = (b - a) / 2, n = H + out;
      if (dx !== 0) statics.push({ p: [dx * n, y, c], h: [thick, hy, len], color });
      else statics.push({ p: [c, y, dz * n], h: [len, hy, thick], color });
    };
    // 골대 양옆의 담(경기장 밖으로 못 나가게, 점프로도 못 넘는 높이)
    along(-H - 0.5, -G, wallH / 2, wallH / 2, 0.5, 0.5, '#b693ff');
    along(G, H + 0.5, wallH / 2, wallH / 2, 0.5, 0.5, '#b693ff');
    // 골대: 바닥, 뒷벽, 옆벽, 위 가로대(팀 색)
    const col = TEAM_COLORS[team];
    const fx = dx * (H + D / 2), fz = dz * (H + D / 2);
    statics.push(dx !== 0 ? { p: [fx, -0.5, 0], h: [D / 2, 0.5, G + 0.5], color: '#ffffff' } : { p: [0, -0.5, fz], h: [G + 0.5, 0.5, D / 2], color: '#ffffff' });
    along(-G - 0.5, G + 0.5, wallH / 2, wallH / 2, 0.4, D, col);
    for (const sgn of [-1, 1]) {
      if (dx !== 0) statics.push({ p: [fx, wallH / 2, sgn * (G + 0.25)], h: [D / 2, wallH / 2, 0.25], color: col });
      else statics.push({ p: [sgn * (G + 0.25), wallH / 2, fz], h: [0.25, wallH / 2, D / 2], color: col });
    }
    along(-G - 0.5, G + 0.5, wallH + 0.3, 0.3, 0.3, 0.3, col);
  });
  return {
    id: 'teamball', name: '팀 공 넣기',
    statics, movers: [], sweepers: [], pads: [], tiles: [],
    checkpoints: [{ zone: { p: [0, 0, 0], h: [0, 0, 0] }, spawn: [0, 0, 0] }],
    spawnCols: 8, spawnSpacing: 1.5, spawnRing: 6, killY: -8,
    // 팀마다 자기 골대 앞에서 가운데를 보고 출발한다
    // 골대에서 충분히 떨어져야 뒤에서 비추는 카메라가 골대 안에 갇히지 않는다
    teamSpawns: GOAL_DIRS.map(([dx, dz]) => ({ x: dx * (H - 7), z: dz * (H - 7), yaw: Math.atan2(-dx, -dz) })),
    sky: ['#3fb0ff', '#ffe3f4'],
  };
}
