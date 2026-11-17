import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { GAMES, LEVEL_LABEL, MAX_PLAYERS, getGame, type QLevel, type RoomState } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';
import { Scene } from '../three/Scene';
import { BankEditor } from './BankEditor';
import { useSecondsLeft } from './hooks';
import { Blob, CountdownOverlay, DrawOverlay, FinalOverlay, GameHud, ResultOverlay, SettingsButton, StatusOverlays, standings } from './Overlays';

const PHASE_LABEL: Record<RoomState['phase'], string> = {
  lobby: '대기실', draw: '게임 추첨 중', countdown: '카운트다운', playing: '경기 중', result: '라운드 결과', final: '최종 시상식',
};

/** 학생이 접속할 주소. 교사가 localhost로 열었으면 같은 Wi-Fi용 IP 주소로 바꿔 준다. */
function useJoinUrl(code: string) {
  const [base, setBase] = useState(location.origin);
  useEffect(() => {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;
    fetch('/api/info').then((r) => r.json()).then((info: { lan: string[] }) => {
      if (info.lan[0]) setBase(`${location.protocol}//${info.lan[0]}${location.port ? `:${location.port}` : ''}`);
    }).catch(() => {});
  }, []);
  return `${base}/?code=${code}`;
}

function downloadCsv(room: RoomState) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const head = ['순위', '닉네임', '총점', ...room.history.map((h) => `${h.round}R ${getGame(h.gameId)?.name ?? h.gameId}`)];
  const lines = standings(room).map((r) => [
    r.rank, r.name, r.total,
    ...room.history.map((h) => { const row = h.rows.find((x) => x.id === r.id); return row ? `${row.points}점 (${row.rank}위, ${row.detail})` : '-'; }),
  ]);
  const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(',')).join('\r\n'); // BOM: 엑셀에서 한글이 깨지지 않게
  const url = URL.createObjectURL(new Blob2([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `class-party-40_${room.code}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const Blob2 = globalThis.Blob;

export function HostScreen() {
  const room = useStore((s) => s.room);
  const [wide, setWide] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [qr, setQr] = useState('');
  const url = useJoinUrl(room?.code ?? '');
  const left = useSecondsLeft(2);
  useEffect(() => { if (room?.code) QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#3b2f63' } }).then(setQr); }, [url, room?.code]);
  const rows = useMemo(() => (room ? standings(room) : []), [room]);
  if (!room) return <div className="party-bg flex h-full items-center justify-center font-display text-2xl">방을 여는 중…</div>;
  const cmd = net.hostCmd.bind(net);
  const connected = room.players.filter((p) => p.connected).length;
  const lobby = room.phase === 'lobby';
  const running = !lobby && room.phase !== 'final';
  const toggleGame = (id: string) => {
    const games = room.config.games.includes(id) ? room.config.games.filter((g) => g !== id) : [...room.config.games, id];
    if (games.length) cmd({ type: 'config', config: { ...room.config, games } });
  };

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-cream lg:flex-row">
      <div className={`relative ${wide ? 'flex-1' : 'h-[42vh] lg:h-auto lg:flex-1'}`}>
        <Scene spectator />
        {lobby && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
            <div className="card flex flex-col items-center gap-2 text-center sm:flex-row sm:gap-6 sm:text-left">
              {qr && <img src={qr} alt="입장 QR 코드" className="h-36 w-36 rounded-2xl sm:h-48 sm:w-48" />}
              <div>
                <div className="font-display text-xl opacity-70">입장 코드</div>
                <div className="font-display text-6xl tracking-widest text-grape tabular-nums sm:text-8xl">{room.code}</div>
                <div className="pointer-events-auto select-text break-all font-display text-base opacity-80">{url}</div>
              </div>
            </div>
          </div>
        )}
        {room.phase === 'draw' && <DrawOverlay room={room} />}
        {room.phase === 'countdown' && <CountdownOverlay room={room} />}
        {room.phase === 'playing' && <GameHud room={room} myId={null} />}
        {room.phase === 'result' && <ResultOverlay room={room} myId={null} />}
        {room.phase === 'final' && (
          <FinalOverlay room={room} myId={null}>
            <button className="btn-mint !py-2 !text-base" onClick={() => downloadCsv(room)}>⬇ 결과 내려받기(CSV)</button>
            <button className="btn-grape !py-2 !text-base" onClick={() => cmd({ type: 'toLobby' })}>대기실로 돌아가기</button>
          </FinalOverlay>
        )}
        <button className="chip absolute bottom-3 left-3 z-30" onClick={() => setWide(!wide)}>{wide ? '◧ 진행 패널 보기' : '⛶ 경기 화면 크게'}</button>
        <SettingsButton host />
        <StatusOverlays room={room} />
      </div>

      {bankOpen && <BankEditor onClose={() => setBankOpen(false)} />}
      {!wide && (
        <aside className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t-4 border-ink/10 p-3 lg:w-[380px] lg:flex-none lg:border-l-4 lg:border-t-0">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-display text-2xl">방 {room.code}</div>
              <div className="text-sm opacity-70">
                {PHASE_LABEL[room.phase]}{room.round > 0 && ` · ${room.round}/${room.config.rounds}라운드`}
                {room.phaseEndTick > 0 && !room.paused && ` · ${Math.ceil(left)}초`}
              </div>
            </div>
            <div className="chip tabular-nums">👥 {connected} / {MAX_PLAYERS}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {lobby && <button className="btn-bubble col-span-2 text-2xl" disabled={connected === 0} onClick={() => cmd({ type: 'start' })}>▶ 게임 시작</button>}
            {running && (room.paused
              ? <button className="btn-mint" onClick={() => cmd({ type: 'resume' })}>▶ 계속하기</button>
              : <button className="btn-lemon" onClick={() => cmd({ type: 'pause' })}>⏸ 일시정지</button>)}
            {running && <button className="btn-ghost" onClick={() => cmd({ type: 'skip' })}>⏭ 넘기기</button>}
            {running && <button className="btn-grape col-span-2 !bg-ink" onClick={() => cmd({ type: 'end' })}>■ 강제 종료하고 시상식으로</button>}
            <button className={`btn-ghost col-span-2 !py-2 !text-base ${room.config.studentSound === false ? 'opacity-70' : ''}`} onClick={() => cmd({ type: 'sound', on: room.config.studentSound === false })}>
              {room.config.studentSound === false ? '🔇 학생 기기 소리 꺼짐 (눌러서 켜기)' : '🔊 학생 기기 소리 켜짐 (눌러서 끄기)'}
            </button>
            {room.history.length > 0 && <button className="btn-mint col-span-2 !py-2 !text-base" onClick={() => downloadCsv(room)}>⬇ 결과 내려받기(CSV)</button>}
          </div>

          {lobby && (
            <div className="rounded-2xl bg-white p-3 shadow-popsm">
              <div className="mb-1 font-display">게임 설정</div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm">라운드</span>
                <button className="chip" onClick={() => cmd({ type: 'config', config: { ...room.config, rounds: Math.max(1, room.config.rounds - 1) } })}>−</button>
                <b className="w-6 text-center font-display tabular-nums">{room.config.rounds}</b>
                <button className="chip" onClick={() => cmd({ type: 'config', config: { ...room.config, rounds: Math.min(20, room.config.rounds + 1) } })}>＋</button>
              </div>
              <div className="flex flex-wrap gap-1">
                {GAMES.filter((g) => g.implemented && g.modes.includes(room.config.mode)).map((g) => (
                  <button key={g.id} className={`chip ${room.config.games.includes(g.id) ? '!bg-mint' : 'opacity-50'}`} onClick={() => toggleGame(g.id)}>{g.emoji} {g.name}</button>
                ))}
              </div>
            </div>
          )}

          {room.config.mode === 'chem' && (
            <div className="rounded-2xl bg-white p-3 shadow-popsm">
              <div className="mb-1 flex items-center justify-between font-display">
                <span>⚗️ 화학 문제 <span className="text-sm opacity-60">({room.bankSize}문제)</span></span>
                <button className="chip" onClick={() => setBankOpen(true)}>📚 문제은행 편집</button>
              </div>
              <div className="flex flex-wrap gap-1">
                {[3, 4].map((u) => {
                  const c = room.config.chem!, on = c.units.includes(u);
                  return <button key={u} disabled={!lobby} className={`chip ${on ? '!bg-grape !text-white' : 'opacity-50'}`}
                    onClick={() => cmd({ type: 'config', config: { ...room.config, chem: { ...c, units: on ? c.units.filter((x) => x !== u) : [...c.units, u] } } })}>{u}단원</button>;
                })}
                {(['easy', 'normal', 'hard'] as QLevel[]).map((l) => {
                  const c = room.config.chem!, on = c.levels.includes(l);
                  return <button key={l} disabled={!lobby} className={`chip ${on ? '!bg-bubble !text-white' : 'opacity-50'}`}
                    onClick={() => cmd({ type: 'config', config: { ...room.config, chem: { ...c, levels: on ? c.levels.filter((x) => x !== l) : [...c.levels, l] } } })}>{LEVEL_LABEL[l]}</button>;
                })}
              </div>
            </div>
          )}

          <div className="min-h-0 rounded-2xl bg-white p-3 shadow-popsm">
            <div className="mb-1 font-display">{lobby ? '참가자' : '실시간 순위'}</div>
            {rows.length === 0 && <div className="py-4 text-center opacity-60">아직 아무도 없어요. 학생들에게 코드를 알려 주세요.</div>}
            <div className="flex flex-col gap-1">
              {rows.map((r) => {
                const p = room.players.find((x) => x.id === r.id)!;
                return (
                  <div key={r.id} className={`flex items-center gap-2 rounded-xl px-2 py-1 ${p.connected ? 'bg-cream' : 'bg-ink/10 opacity-60'}`}>
                    {!lobby && <div className="w-6 text-center font-display tabular-nums">{r.rank}</div>}
                    <Blob color={r.color} size={20} />
                    <div className="min-w-0 flex-1 truncate font-display">{r.name}</div>
                    {!p.connected && <span className="text-xs">연결 끊김</span>}
                    {p.connected && !p.active && <span className="text-xs">관전</span>}
                    {running && p.place !== null && <span className="text-xs">{p.out ? '💦' : '🏁'}{p.place}</span>}
                    {!lobby && <div className="w-12 text-right font-display tabular-nums">{r.total}</div>}
                    <button className="rounded-full px-2 text-sm opacity-50 hover:bg-bubble hover:text-white hover:opacity-100" title="내보내기" aria-label={`${r.name} 내보내기`} onClick={() => cmd({ type: 'kick', id: r.id })}>✕</button>
                  </div>
                );
              })}
            </div>
          </div>
          {/* 방 닫기: 실수로 누르지 않게 한 번 더 확인한다 */}
          {closing ? (
            <div className="rounded-2xl bg-bubble/15 p-3">
              <div className="mb-2 font-display">이 방을 닫을까요? 학생들이 모두 나가고 점수가 사라져요.</div>
              <div className="flex gap-2">
                <button className="btn-bubble flex-1 !py-2 !text-base" onClick={() => cmd({ type: 'close' })}>방 닫기</button>
                <button className="btn-ghost flex-1 !py-2 !text-base" onClick={() => setClosing(false)}>취소</button>
              </div>
            </div>
          ) : (
            <button className="self-start rounded-full px-3 py-1 text-sm opacity-60 hover:bg-bubble hover:text-white hover:opacity-100" onClick={() => setClosing(true)}>🗑 방 닫기</button>
          )}
        </aside>
      )}
    </div>
  );
}
