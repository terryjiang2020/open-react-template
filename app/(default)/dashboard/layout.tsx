"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ReactNode } from 'react';
import ChatWidget2 from '@/components/chat-widget-2';
// import { LiveChatWidget } from '@livechat/widget-react';

interface DashboardLayoutProps {
  children: ReactNode;
}

const DashboardLayout = ({ children }: DashboardLayoutProps) => {
  const router = useRouter();
  const pathname = usePathname();

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

  const navItems = [
    { label: 'Pokémons', href: '/dashboard/pokemons', icon: () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" /></svg> },
    { label: 'Moves', href: '/dashboard/moves', icon: () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" /></svg> },
    // { label: 'Berries', href: '/dashboard/berries', icon: () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" /></svg> },
    { label: 'Abilities', href: '/dashboard/abilities', icon: () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" /></svg> },
    { label: 'Watchlist', href: '/dashboard/watchlist', icon: () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" /></svg> },
    // { label: 'Teams', href: '/dashboard/teams', icon: () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" /></svg> },
  ]

  return (
    <div className="flex h-screen overflow-hidden">
        <aside className="fixed left-0 top-0 z-50 flex h-screen w-64 flex-col border-r border-border bg-card">
          <div className="p-6">
            <h1 className="font-mono text-xl font-bold text-primary">PokéPanel</h1>
            <p className="mt-1 text-xs text-muted-foreground">Data Interface v2.0</p>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-3">
            {navItems.map((item) => {
              const isActive = pathname === item.href

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors" +
                    (isActive ? " bg-primary/10 text-primary" : " text-muted-foreground hover:bg-accent hover:text-foreground")
                  }
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <div className="border-t border-border p-4">
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
              </svg>
              Log Out
            </button>
            <p className="mt-3 font-mono text-xs text-muted-foreground">Active Database: Gen I-II</p>
          </div>
        </aside>
        <main className="ml-64 h-screen overflow-y-auto p-4 flex-1">
            {children}
        </main>
        <ChatWidget2 />
        {/* <LiveChatWidget license="12332502" group="0" />  */}
    </div>
  );
};

export default DashboardLayout;