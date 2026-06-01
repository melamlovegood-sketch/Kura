import { Link, useLocation } from 'react-router-dom'
import { Home, ListTodo, ShoppingBag, BookOpen, Wallet, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type ReactNode } from 'react'
import { AchievementToast } from '@/components/achievements/AchievementToast'

const NAV_ITEMS = [
  { to: '/',          Icon: Home,        label: '主页' },
  { to: '/billing',   Icon: Wallet,      label: '账单' },
  { to: '/wishlist',  Icon: ListTodo,    label: '清单' },
  { to: '/execution', Icon: ShoppingBag, label: '执行' },
  { to: '/review',    Icon: BookOpen,    label: '复盘' },
] as const

export function AppLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()

  return (
    <div className="flex h-full flex-col">
      {/* 成就解锁 Toast（全局，2 秒自动消失） */}
      <AchievementToast />

      {/* ── Desktop top bar (md+) ─────────────────────────────── */}
      <header className="hidden md:flex fixed top-0 left-0 right-0 z-50 h-[52px] items-center justify-center bg-page border-b-theme">
        <div className="flex items-center gap-2.5">
          <SquirrelMark small />
          <span
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontSize: 22,
              color: 'var(--text-primary)',
              letterSpacing: '-0.01em',
              lineHeight: 1,
            }}
          >
            KURA
          </span>
        </div>
      </header>

      {/* ── 设置入口：右上角齿轮（取代底部导航里的「设置」） ───────── */}
      <Link
        to="/settings"
        aria-label="设置"
        className={cn(
          'fixed top-3 right-4 z-[55] rounded-lg p-1.5 transition-colors',
          pathname === '/settings' ? 'text-ink' : 'text-ink-4 hover:text-ink-2',
        )}
      >
        <Settings size={20} />
      </Link>

      {/* Spacer that reserves space for the fixed desktop header */}
      <div className="hidden md:block h-[52px] shrink-0" />

      {/* ── Main content (full-width pass-through; pages center themselves) ── */}
      <main className="flex-1 overflow-y-auto bg-page pb-20 md:pb-36">
        {children}
      </main>

      {/* ── Mobile bottom nav (<md) ───────────────────────────── */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t-theme bg-card md:hidden">
        <div className="flex max-w-[640px] mx-auto">
          {NAV_ITEMS.map(({ to, Icon, label }) => (
            <BottomNavItem
              key={to}
              to={to}
              icon={<Icon size={18} />}
              label={label}
              active={pathname === to}
            />
          ))}
        </div>
      </nav>

      {/* ── Desktop bottom nav (md+) ──────────────────────────── */}
      <nav className="hidden md:flex fixed bottom-0 left-0 right-0 z-40 border-t-theme bg-page justify-center gap-10 py-3">
        {NAV_ITEMS.map(({ to, Icon, label }) => (
          <DesktopNavItem
            key={to}
            to={to}
            icon={<Icon size={20} />}
            label={label}
            active={pathname === to}
          />
        ))}
      </nav>
    </div>
  )
}

/* ── Desktop nav item ─────────────────────────────────────────────────── */

function DesktopNavItem({ to, icon, label, active }: {
  to: string; icon: ReactNode; label: string; active: boolean
}) {
  return (
    <Link
      to={to}
      className={cn(
        'flex flex-col items-center gap-1 text-[12px] font-medium transition-colors',
        active ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
      )}
    >
      {icon}
      <span>{label}</span>
    </Link>
  )
}

/* ── Mobile bottom nav item ───────────────────────────────────────────── */

function BottomNavItem({ to, icon, label, active }: {
  to: string; icon: ReactNode; label: string; active: boolean
}) {
  return (
    <Link
      to={to}
      className={cn(
        'flex flex-1 flex-col items-center gap-1 py-3 text-[12px] font-medium tracking-wide transition-colors',
        active ? 'text-ink' : 'text-ink-4 hover:text-ink-3',
      )}
    >
      {icon}
      <span>{label}</span>
    </Link>
  )
}

/* ── Squirrel mark ────────────────────────────────────────────────────── */

function SquirrelMark({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 26 : 54}
      height={small ? 28 : 59}
      viewBox="0 0 150 165"
      fill="none"
      className="text-ink-2"
    >
      {/* acorn */}
      <ellipse cx="62" cy="36" rx="11" ry="13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M51 37 C53 30 71 30 73 37" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M62 23 L62 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M62 18 C62 15 65 13 67 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* squirrel body */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M103 87 C99 88 93 90 89 91 L88 95 C91 96 95 98 98 105 L91 115 C91 115 95 115 100 115 C104 116 103 122 103 122 H58 C58 122 54 97 74 80 C73 70 74 63 78 59 L78 48 L87 55 C96 54 102 63 103 70 L92 74 L91 81 L99 80 L102 75 C109 77 111 85 103 87 Z M49 122 C38 120 31 114 31 102 C31 88 39 59 16 63 L15 60 C19 51 27 42 40 42 C54 42 61 51 61 68 C61 88 48 89 49 122 Z"
        stroke="currentColor"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(8,22)"
      />
      <path d="M78 48 C73 43 66 41 64 44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
