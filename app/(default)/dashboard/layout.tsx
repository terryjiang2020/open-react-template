"use client";

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ReactNode } from 'react';
import ChatWidget2 from '@/components/chat-widget-2';

interface DashboardLayoutProps {
  children: ReactNode;
}

const DashboardLayout = ({ children }: DashboardLayoutProps) => {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/signin');
    }
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    router.push('/signin');
  };

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
        <aside style={{ width: '250px', background: 'black', padding: '1rem', boxShadow: '2px 0 5px rgba(0, 0, 0, 0.1)' }}>
            <nav>
            <ul style={{ listStyle: 'none', padding: 0 }}>
                <li style={{ marginBottom: '1rem' }}><Link href="/dashboard/pokemons">Pokémons</Link></li>
                <li style={{ marginBottom: '1rem' }}><Link href="/dashboard/moves">Moves</Link></li>
                {/* <li style={{ marginBottom: '1rem' }}><Link href="/dashboard/berries">Berries</Link></li> */}
                <li style={{ marginBottom: '1rem' }}><Link href="/dashboard/abilities">Abilities</Link></li>
                <li style={{ marginBottom: '1rem' }}><Link href="/dashboard/watchlist">Watchlist</Link></li>
                <li style={{ marginBottom: '1rem' }}><Link href="/dashboard/teams">Teams</Link></li>
            </ul>
            </nav>
            <button onClick={handleLogout} style={{ marginTop: 'auto', display: 'block', background: '#ff4d4d', color: '#fff', border: 'none', padding: '0.5rem 1rem', cursor: 'pointer', borderRadius: '4px' }}>Log Out</button>
        </aside>
        <main style={{ flex: 1, padding: '1rem' }}>
            {children}
        </main>
        <ChatWidget2 />
    </div>
  );
};

export default DashboardLayout;