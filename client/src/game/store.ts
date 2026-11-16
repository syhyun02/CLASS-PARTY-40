import { create } from 'zustand';
import type { RoomState } from '@shared';

export type Screen = 'home' | 'hostSetup' | 'join' | 'play' | 'host';
export type Quality = 'low' | 'medium' | 'high';

const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

interface Store {
  screen: Screen;
  room: RoomState | null;
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
