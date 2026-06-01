import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore, takeRegisterIntent } from '@/store/auth'
import { cn } from '@/lib/utils'

type Tab = 'signin' | 'signup'
/** Sign-up sub-state: collecting email+password, or entering the emailed OTP. */
type Phase = 'filling' | 'verifying'

const RESEND_COOLDOWN = 60 // seconds

/**
 * Full-screen email + password auth gate. Shown by App whenever there is no
 * session. Two tabs (登录 / 注册) over one shared form.
 *
 * Sign-in is one step (email + password). Sign-up is two steps: ① create the
 * account and have Supabase email a 6-digit OTP, then ② enter that code to
 * verify and auto-sign-in. On success the auth store's onAuthStateChange
 * listener flips the app to the authed tree — a fresh account lands in the
 * cold-start onboarding because its tables are empty.
 */
export function Login() {
  const signIn        = useAuthStore((s) => s.signIn)
  const sendOtp       = useAuthStore((s) => s.sendOtp)
  const verifyOtp     = useAuthStore((s) => s.verifyOtp)
  const resendOtp     = useAuthStore((s) => s.resendOtp)
  const enterGuest    = useAuthStore((s) => s.enterGuestMode)

  // Land on the 注册 tab when arriving here straight from a guest "升级账号" tap.
  const [tab, setTab]           = useState<Tab>(() => (takeRegisterIntent() ? 'signup' : 'signin'))
  const [phase, setPhase]       = useState<Phase>('filling')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode]         = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [notice, setNotice]     = useState<string | null>(null)
  const [busy, setBusy]         = useState(false)
  const [cooldown, setCooldown] = useState(0)

  // Tick down the resend cooldown once per second while it's active.
  useEffect(() => {
    if (cooldown <= 0) return
    const id = setInterval(() => setCooldown((c) => c - 1), 1000)
    return () => clearInterval(id)
  }, [cooldown])

  function switchTab(next: Tab) {
    setTab(next); setPhase('filling'); setError(null); setNotice(null); setCode('')
  }

  async function handleSubmit() {
    const e = email.trim()
    if (!e || !password) { setError('请输入邮箱和密码'); return }
    if (tab === 'signup' && password.length < 6) { setError('密码至少 6 位'); return }

    setBusy(true); setError(null); setNotice(null)
    try {
      if (tab === 'signin') {
        const res = await signIn(e, password)
        if (res.needsVerify) {
          // Account exists but email was never verified → resend OTP and switch
          // to the verification step (reusing the sign-up VerifyForm).
          await resendOtp(e)
          setPhase('verifying')
          setNotice('你的邮箱尚未验证，验证码已重新发送，请查收')
          setCooldown(RESEND_COOLDOWN)
          return
        }
        if (res.error) setError(res.error)
        // Success → onAuthStateChange takes over and unmounts this screen.
        return
      }
      // Sign-up step ①: email a 6-digit OTP (registers the address if new). This is
      // passwordless, so there's never a session yet — always go to the verify step,
      // where the typed password gets applied to the account after the code checks out.
      const res = await sendOtp(e)
      if (res.error) { setError(res.error); return }
      setPhase('verifying')
      setNotice('验证码已发送，请查收邮件后输入验证码')
      setCooldown(RESEND_COOLDOWN)
    } finally {
      setBusy(false)
    }
  }

  // Sign-up step ②: exchange the 6-digit code for a session.
  async function handleVerify() {
    const c = code.trim()
    if (c.length !== 6) { setError('请输入 6 位验证码'); return }

    setBusy(true); setError(null); setNotice(null)
    try {
      const res = await verifyOtp(email.trim(), c, password)
      if (res.error) setError(res.error)
      // Success → onAuthStateChange takes over and unmounts this screen.
    } finally {
      setBusy(false)
    }
  }

  async function handleResend() {
    if (cooldown > 0 || busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const res = await resendOtp(email.trim())
      if (res.error) { setError(res.error); return }
      setNotice('验证码已发送，请查收邮件')
      setCooldown(RESEND_COOLDOWN)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-page px-6">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col gap-7">
          {/* ── Brand ── */}
          <div className="flex flex-col items-center gap-3">
            <SquirrelMark />
            <div className="text-center">
              <p
                style={{ fontFamily: "'DM Serif Display', Georgia, serif" }}
                className="text-[28px] leading-none text-ink"
              >
                KURA
              </p>
              <p className="mt-2 text-[14px] text-ink-3">
                {phase === 'verifying'
                  ? '输入邮件里的 6 位验证码'
                  : tab === 'signin'
                    ? '欢迎回来，登录继续'
                    : '创建账号，开始你的消费决策'}
              </p>
            </div>
          </div>

          {phase === 'verifying' ? (
            <VerifyForm
              email={email}
              code={code}
              onCodeChange={(v) => { setCode(v); setError(null) }}
              onVerify={handleVerify}
              onResend={handleResend}
              onBack={() => { setPhase('filling'); setCode(''); setError(null); setNotice(null) }}
              cooldown={cooldown}
              busy={busy}
              error={error}
              notice={notice}
            />
          ) : (
            <>
              {/* ── Tabs ── */}
              <div className="flex rounded-xl bg-card-alt p-1">
                {(['signin', 'signup'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => switchTab(t)}
                    className={cn(
                      'flex-1 rounded-lg py-2 text-[14px] font-medium transition-colors',
                      tab === t ? 'bg-card text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2',
                    )}
                  >
                    {t === 'signin' ? '登录' : '注册'}
                  </button>
                ))}
              </div>

              {/* ── Form ── */}
              <form
                className="flex flex-col gap-4"
                onSubmit={(ev) => { ev.preventDefault(); void handleSubmit() }}
              >
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-ink-3">邮箱</span>
                  <Input
                    type="email"
                    name="email"
                    id="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(null) }}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-ink-3">密码</span>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null) }}
                    placeholder={tab === 'signup' ? '至少 6 位' : '••••••'}
                    autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                  />
                </label>

                {error && <p className="text-[13px] leading-relaxed text-red-500">{error}</p>}
                {notice && <p className="text-[13px] leading-relaxed text-amber-700">{notice}</p>}

                <Button type="submit" className="mt-1 w-full" disabled={busy}>
                  {busy ? '请稍候…' : tab === 'signin' ? '登录' : '注册'}
                </Button>
              </form>

              <p className="text-center text-[12px] leading-relaxed text-ink-4">
                {tab === 'signin' ? '还没有账号？' : '已有账号？'}
                <button
                  onClick={() => switchTab(tab === 'signin' ? 'signup' : 'signin')}
                  className="ml-1 text-ink-2 underline-offset-2 hover:underline"
                >
                  {tab === 'signin' ? '去注册' : '去登录'}
                </button>
              </p>

              {/* ── 游客模式入口 ── */}
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--border)]" />
                <span className="text-[11px] text-ink-4">或</span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>
              <p className="text-center text-[12px] leading-relaxed text-ink-4">
                还没想好？
                <button
                  onClick={enterGuest}
                  className="ml-1 font-medium text-ink-2 underline-offset-2 hover:underline"
                >
                  先看看，不注册
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── OTP verification step ────────────────────────────────────────────────── */

interface VerifyFormProps {
  email: string
  code: string
  onCodeChange: (value: string) => void
  onVerify: () => void
  onResend: () => void
  onBack: () => void
  cooldown: number
  busy: boolean
  error: string | null
  notice: string | null
}

function VerifyForm({
  email, code, onCodeChange, onVerify, onResend, onBack, cooldown, busy, error, notice,
}: VerifyFormProps) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(ev) => { ev.preventDefault(); void onVerify() }}
    >
      <p className="text-center text-[13px] leading-relaxed text-ink-3">
        验证码已发送至
        <span className="mx-1 font-medium text-ink-2">{email}</span>
      </p>

      <OtpInput value={code} onChange={onCodeChange} onComplete={onVerify} />

      {error && <p className="text-center text-[13px] leading-relaxed text-red-500">{error}</p>}
      {notice && <p className="text-center text-[13px] leading-relaxed text-amber-700">{notice}</p>}

      <Button type="submit" className="mt-1 w-full" disabled={busy || code.length !== 6}>
        {busy ? '请稍候…' : '验证'}
      </Button>

      <div className="flex items-center justify-center gap-1 text-[12px] text-ink-4">
        <span>没收到？</span>
        <button
          type="button"
          onClick={onResend}
          disabled={cooldown > 0 || busy}
          className={cn(
            'underline-offset-2',
            cooldown > 0 ? 'cursor-not-allowed text-ink-4' : 'text-ink-2 hover:underline',
          )}
        >
          {cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送'}
        </button>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="text-center text-[12px] text-ink-4 underline-offset-2 hover:underline"
      >
        ← 返回修改邮箱
      </button>
    </form>
  )
}

/** Six independent single-digit cells that behave like one 6-digit field:
 *  auto-advance on type, backspace to the previous cell, and full-code paste. */
function OtpInput({
  value, onChange, onComplete,
}: {
  value: string
  onChange: (next: string) => void
  onComplete: () => void
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const digits = value.split('')

  // Focus the first cell when the verify step mounts.
  useEffect(() => { refs.current[0]?.focus() }, [])

  function setDigit(index: number, raw: string) {
    const d = raw.replace(/\D/g, '')
    if (!d) return
    // Typing/pasting may carry several digits — spread them across cells.
    const chars = d.split('')
    const next = value.split('')
    let cursor = index
    for (const ch of chars) {
      if (cursor > 5) break
      next[cursor] = ch
      cursor++
    }
    const joined = next.join('').slice(0, 6)
    onChange(joined)
    const focusAt = Math.min(cursor, 5)
    refs.current[focusAt]?.focus()
    if (joined.length === 6) onComplete()
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const next = value.split('')
      if (next[index]) {
        next[index] = ''
        onChange(next.join(''))
      } else if (index > 0) {
        next[index - 1] = ''
        onChange(next.join(''))
        refs.current[index - 1]?.focus()
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      refs.current[index - 1]?.focus()
    } else if (e.key === 'ArrowRight' && index < 5) {
      refs.current[index + 1]?.focus()
    }
  }

  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={6}
          value={digits[i] ?? ''}
          onChange={(e) => setDigit(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
          className="h-12 w-11 rounded-xl border-theme bg-card text-center text-[20px] font-medium text-ink outline-none transition-colors focus:ring-1 focus:ring-[var(--border)]"
        />
      ))}
    </div>
  )
}

/* ── Squirrel mark (matches AppLayout/Splash) ─────────────────────────────── */

function SquirrelMark() {
  return (
    <svg width={54} height={59} viewBox="0 0 150 165" fill="none" className="text-ink-2">
      <ellipse cx="62" cy="36" rx="11" ry="13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M51 37 C53 30 71 30 73 37" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M62 23 L62 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M62 18 C62 15 65 13 67 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
