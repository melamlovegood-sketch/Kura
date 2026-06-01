import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'
import type { WishPoolData } from '@/types/db'

/** Progress milestones (in %) that trigger the squirrel celebration. */
const MILESTONES = [25, 50, 75, 100] as const
export type Milestone = (typeof MILESTONES)[number]

/** A "忍住了" record made while no wish pool existed, kept until a goal is pinned. */
export interface PendingSaving {
  amount: number
  description: string
}

interface WishPoolStore {
  pool: WishPoolData | null
  loaded: boolean
  /** Set when addSavings crosses a new milestone — drives MilestoneAnimation. */
  milestone: Milestone | null
  /** Milestones already celebrated, keyed by pool id (survives reloads). */
  celebrated: Record<string, number[]>
  /** "忍住了" amounts stashed before a goal existed; flushed into the pool on load. */
  pendingSavings: PendingSaving[]
  load: () => Promise<void>
  addSavings: (amount: number, description: string) => Promise<void>
  /** Stash a savings record locally when there is no active pool yet. */
  stashSavings: (amount: number, description: string) => void
  /** Clear the active celebration once its animation has played. */
  clearMilestone: () => void
  /** Clear a goal-reached pool once the user acts on the buy guidance. */
  dismissCompleted: () => void
  /** Manually mark a pool reached (stamps completed_at) — used by the detail sheet's 已达成. */
  markReached: (poolId: string) => Promise<void>
  /** Permanently delete a wish pool (savings included) and unpin its focus item. */
  deletePool: (poolId: string, focusItemId: string) => Promise<void>
  /** Remove any wish pool tied to a wishlist item — used when that item is deleted. */
  removePoolForItem: (itemId: string) => Promise<void>
}

const isReached = (p: WishPoolData | null): boolean =>
  !!p && p.target_amount > 0 && p.saved_amount >= p.target_amount

const pctOf = (p: WishPoolData): number =>
  p.target_amount > 0 ? (p.saved_amount / p.target_amount) * 100 : 0

export const useWishPoolStore = create<WishPoolStore>()(persist((set, get) => ({
  pool: null,
  loaded: false,
  milestone: null,
  celebrated: {},
  pendingSavings: [],

  clearMilestone: () => set({ milestone: null }),

  load: async () => {
    const { data } = await db
      .from('v_active_wish_pool')
      .select('*')
      .maybeSingle()

    const active = (data as WishPoolData | null) ?? null

    if (active) {
      set({ pool: active, loaded: true })

      // A goal now exists → replay any "忍住了" amounts stashed while there was
      // none. Going through addSavings (not a silent batch insert) means count-up
      // animation + milestone detection fire exactly as a live add would.
      const pending = get().pendingSavings
      if (pending.length > 0) {
        for (const p of pending) await get().addSavings(p.amount, p.description)
        set({ pendingSavings: [] })
      }
      return
    }

    // No active pool in the view. A just-reached pool gets completed_at set and
    // is filtered out of v_active_wish_pool — keep it locally so the buy-guidance
    // card survives reloads until the user acts on it (or dismisses it).
    set({ pool: isReached(get().pool) ? get().pool : null, loaded: true })
  },

  stashSavings: (amount, description) =>
    set((s) => ({ pendingSavings: [...s.pendingSavings, { amount, description }] })),

  dismissCompleted: () => set({ pool: null }),

  markReached: async (poolId) => {
    // Stamp completed_at so v_active_wish_pool filters it out, then drop it from
    // local state — the home card disappears and won't resurrect on reload.
    await db
      .from('wish_pools')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', poolId)
    if (get().pool?.id === poolId) set({ pool: null })
  },

  deletePool: async (poolId, focusItemId) => {
    // savings_records cascade in Postgres (ON DELETE CASCADE), but the guest-mode
    // shim has no FKs — delete them explicitly so both backends end up clean.
    await db.from('savings_records').delete().eq('wish_pool_id', poolId)
    await db.from('wish_pools').delete().eq('id', poolId)
    // Unpin the focus item so a stale is_focus flag can't resurrect the pool view.
    if (focusItemId) await db.from('wishlist_items').update({ is_focus: false }).eq('id', focusItemId)
    if (get().pool?.id === poolId) set({ pool: null })
  },

  removePoolForItem: async (itemId) => {
    const { data } = await db.from('wish_pools').select('id').eq('focus_item_id', itemId)
    const pools = (data as { id: string }[] | null) ?? []
    for (const p of pools) await get().deletePool(p.id, itemId)
  },

  addSavings: async (amount, description) => {
    const pool = get().pool
    if (!pool) return

    await db.from('savings_records').insert({
      wish_pool_id: pool.id,
      amount,
      description: description || null,
      user_id: await getCurrentUserId(),
    })

    // Refetch to get updated saved_amount
    const { data } = await db
      .from('v_active_wish_pool')
      .select('*')
      .maybeSingle()

    // Mark completed if target reached
    const updated = data as WishPoolData | null
    if (updated && updated.saved_amount >= updated.target_amount && !updated.completed_at) {
      await db
        .from('wish_pools')
        .update({ completed_at: new Date().toISOString() })
        .eq('id', pool.id)
    }

    // Detect newly-crossed milestones. Each only fires once per pool (tracked in
    // `celebrated`, which is persisted), so a reload or a big jump won't re-trigger.
    let milestone = get().milestone
    let celebrated = get().celebrated
    if (updated) {
      const newPct = pctOf(updated)
      const done = celebrated[updated.id] ?? []
      const crossed = MILESTONES.filter((m) => newPct >= m && !done.includes(m))
      if (crossed.length > 0) {
        milestone = Math.max(...crossed) as Milestone
        celebrated = { ...celebrated, [updated.id]: [...done, ...crossed] }
      }
    }

    set({ pool: updated, milestone, celebrated })
  },
}), {
  name: 'kura-wishpool',
  storage: createJSONStorage(() => localStorage),
  partialize: (s) => ({ pool: s.pool, celebrated: s.celebrated, pendingSavings: s.pendingSavings }),
}))
