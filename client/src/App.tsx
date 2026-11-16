import { Suspense, lazy, useEffect, useState } from 'react';
import { net } from './game/net';
import { useStore } from './game/store';
import { Home, HostSetup, Join } from './ui/Screens';

// 3D 화면(Three.js)은 방에 들어갈 때 내려받는다
const PlayScreen = lazy(() => import('./ui/PlayScreen').then((m) => ({ default: m.PlayScreen })));
const HostScreen = lazy(() => import('./ui/HostScreen').then((m) => ({ default: m.HostScreen })));
const Loading = () => <div className="party-bg flex h-full items-center justify-center font-display text-2xl">경기장을 불러오는 중…</div>;

export default function App() {
  const screen = useStore((s) => s.screen);
  const [ready, setReady] = useState(false);
  const urlCode = new URLSearchParams(location.search).get('code')?.replace(/\D/g, '').slice(0, 6) ?? '';

  useEffect(() => {
    // 새로고침했으면 원래 자리로 돌아가고, QR로 들어왔으면 입장 화면부터 보여 준다
    net.restore().then((ok) => {
      if (!ok && urlCode) useStore.setState({ screen: 'join' });
      setReady(true);
    });
  }, []);

  if (!ready) return <div className="party-bg flex h-full items-center justify-center font-display text-2xl">CLASS PARTY 40</div>;
  if (screen === 'play') return <Suspense fallback={<Loading />}><PlayScreen /></Suspense>;
  if (screen === 'host') return <Suspense fallback={<Loading />}><HostScreen /></Suspense>;
  if (screen === 'hostSetup') return <HostSetup />;
  if (screen === 'join') return <Join initialCode={urlCode} />;
  return <Home />;
}
