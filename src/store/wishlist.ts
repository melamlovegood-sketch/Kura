import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'
import { useWishPoolStore } from '@/store/wishpool'
import type { ParsedWishlistItem, WishlistItem } from '@/types/db'

interface WishlistStore {
  items: WishlistItem[]
  loaded: boolean
  load: () => Promise<void>
  add: (data: ParsedWishlistItem, impulseRecordId?: string) => Promise<WishlistItem | null>
  /** Set this item as the wish pool focus, create/reuse wish_pool record */
  pin: (item: WishlistItem) => Promise<void>
  /** Patch arbitrary editable fields (detail page inline edits + AI fill). */
  update: (id: string, patch: Partial<WishlistItem>) => Promise<void>
  /** Mark an item bought → leaves the active list; drops any linked 许愿池. */
  markPurchased: (id: string) => Promise<void>
  /** Move an item up/down the list; renumbers `priority` to reflect display order. */
  move: (id: string, dir: 'up' | 'down') => Promise<void>
  dismiss: (id: string) => Promise<void>
  /** Update last_nudged_at (user responded to "还想要吗") */
  markNudged: (id: string) => Promise<void>
}

export const useWishlistStore = create<WishlistStore>()(persist((set, get) => ({
  items: [],
  loaded: false,

  load: async () => {
    const { data } = await db
      .from('wishlist_items')
      .select('*')
      .eq('status', 'active')
      .order('priority', { ascending: false })
      .order('added_at', { ascending: true })

    set({ items: (data as WishlistItem[]) ?? [], loaded: true })
  },

  add: async (parsed, impulseRecordId) => {
    const { data } = await db
      .from('wishlist_items')
      .insert({
        item_name: parsed.item_name,
        category: parsed.category ?? null,
        estimated_price: parsed.estimated_price ?? null,
        season_tag: parsed.season_tag,
        need_intensity: parsed.need_intensity ?? null,
        worthiness_score: parsed.worthiness_score ?? null,
        worthiness_reason: parsed.worthiness_reason ?? null,
        impulse_record_id: impulseRecordId ?? null,
        priority: 0,
        status: 'active',
        user_id: await getCurrentUserId(),
      })
      .select()
      .single()

    if (data) {
      set({ items: [...get().items, data as WishlistItem] })
      return data as WishlistItem
    }
    return null
  },

  pin: async (item) => {
    // Unpin all others
    const unpin = await db
      .from('wishlist_items')
      .update({ is_focus: false })
      .eq('is_focus', true)
    if (unpin.error) throw new Error(unpin.error.message)

    // Pin this item
    const pin = await db
      .from('wishlist_items')
      .update({ is_focus: true })
      .eq('id', item.id)
    if (pin.error) throw new Error(pin.error.message)

    // Create wish_pool if none exists for this item
    const { data: existing, error: selErr } = await db
      .from('wish_pools')
      .select('id')
      .eq('focus_item_id', item.id)
      .is('completed_at', null)
      .maybeSingle()
    if (selErr) throw new Error(selErr.message)

    if (!existing) {
      const ins = await db.from('wish_pools').insert({
        focus_item_id: item.id,
        target_amount: item.estimated_price ?? 0,
        user_id: await getCurrentUserId(),
      })
      // Errors here (e.g. RLS 401 on wish_pools) were the reason pin silently did
      // nothing — surface them so the UI can react instead of faking success.
      if (ins.error) throw new Error(ins.error.message)
    }

    // Update local state only after the writes succeeded.
    set({
      items: get().items.map((i) => ({ ...i, is_focus: i.id === item.id })),
    })
  },

  update: async (id, patch) => {
    const { error } = await db.from('wishlist_items').update(patch).eq('id', id)
    if (error) throw new Error(error.message)
    set({ items: get().items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })
  },

  markPurchased: async (id) => {
    // Same cleanup as dismiss: a 待购 item can be a 许愿池 focus, and the active-pool
    // view only checks is_focus — so drop the linked pool or the home card keeps
    // showing a goal for something the user just marked bought.
    await useWishPoolStore.getState().removePoolForItem(id)
    await db.from('wishlist_items').update({ status: 'purchased' }).eq('id', id)
    set({ items: get().items.filter((i) => i.id !== id) })
  },

  move: async (id, dir) => {
    const items = [...get().items]
    const idx = items.findIndex((i) => i.id === id)
    if (idx < 0) return
    const target = dir === 'up' ? idx - 1 : idx + 1
    if (target < 0 || target >= items.length) return

    // Swap the two neighbours in display order…
    ;[items[idx], items[target]] = [items[target], items[idx]]

    // …then renumber every row so `priority` strictly mirrors the list (top =
    // highest). load() orders by priority desc, so this survives reloads. Only
    // persist rows whose priority actually changed.
    const n = items.length
    const updates: { id: string; priority: number }[] = []
    const renumbered = items.map((it, i) => {
      const priority = n - i
      if (it.priority !== priority) updates.push({ id: it.id, priority })
      return { ...it, priority }
    })

    set({ items: renumbered })
    await Promise.all(
      updates.map((u) => db.from('wishlist_items').update({ priority: u.priority }).eq('id', u.id)),
    )
  },

  dismiss: async (id) => {
    // Drop the linked 许愿池 first: its focus_item_id points at this item, and the
    // active-pool view only filters on is_focus — so without this the home wish-pool
    // card keeps showing a goal for a 待购 item the user just deleted (bug2).
    await useWishPoolStore.getState().removePoolForItem(id)
    await db.from('wishlist_items').update({ status: 'dismissed' }).eq('id', id)
    set({ items: get().items.filter((i) => i.id !== id) })
  },

  markNudged: async (id) => {
    const now = new Date().toISOString()
    await db.from('wishlist_items').update({ last_nudged_at: now }).eq('id', id)
    set({
      items: get().items.map((i) =>
        i.id === id ? { ...i, last_nudged_at: now } : i,
      ),
    })
  },
}), {
  name: 'kura-wishlist',
  storage: createJSONStorage(() => localStorage),
  partialize: (s) => ({ items: s.items }),
}))
