import { create } from 'zustand';
import type { CollectState, RoomState } from '@shared';

export type Screen = 'home' | 'hostSetup' | 'join' | 'play' | 'host';
export type Quality = 'low' | 'medium' | 'high';

const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

interface Store {
  screen: Screen;
  room: RoomState | null;
  /** 미니게임별 실시간 상태(보물 점수 등) */
  game: CollectState | null;
  /** 나에게만 온 알림(화학 미로): 통과한 문제, 틀린 문, 마지막 해설 */
  mine: { passed: number; wrong: [number, number][]; explain: { q: number; text: string; first: boolean } | null };
  myId: number | null;
  myName: string;
  online: boolean;
  notice: string | null; // 강퇴·중복 접속 등 안내
  quality: Quality;
  autoQuality: boolean;
  isTouch: boolean;
  contextLost: boolean;
  set: (p: Partial<Store>) => void;
}

const savedQ = (() => { try { return localStorage.getItem('cp40:quality') as Quality | null; } catch { return null; } })();

export const useStore = create<Store>((set) => ({
  screen: 'home',
  room: null,
  game: null,
  mine: { passed: 0, wrong: [], explain: null },
  myId: null,
  myName: '',
  online: false,
  notice: null,
  quality: savedQ ?? (isTouch ? 'medium' : 'high'),
  autoQuality: !savedQ,
  isTouch,
  contextLost: false,
  set: (p) => set(p),
}));

export function setQuality(q: Quality, manual = true) {
  if (manual) { try { localStorage.setItem('cp40:quality', q); } catch { /* 저장 실패는 무시 */ } }
  useStore.setState({ quality: q, autoQuality: manual ? false : useStore.getState().autoQuality });
}
