import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'
import type { AIAdapter, AIMessage } from '@/lib/ai/types'
import type { PricePlatform, PriceRecord, PriceTrack } from '@/types/db'

/** A price drop worth pushing to Home: previous record → newest record. */
export interface PriceDrop {
  track: PriceTrack
  /** Stable key (track + newest record) — once dismissed, never re-shown. */
  key: string
  from: number
  to: number
  diff: number // positive amount saved
}

interface PriceTrackStore {
  tracks: PriceTrack[]
  /** track_id → its records, ascending by recorded_at (oldest first). */
  records: Record<string, PriceRecord[]>
  /** Drop-notification keys the user has dismissed ("知道了"). Persisted. */
  dismissedDrops: string[]
  /** Target-hit keys the user has dismissed ("知道了"). Persisted. */
  dismissedTargets: string[]
  loaded: boolean

  load: () => Promise<void>
  /** New 蹲蹲: insert a track + its first price record. */
  add: (item_name: string, price: number, platform: PricePlatform) => Promise<PriceTrack | null>
  /** Append a new price point to an existing track. */
  addPriceRecord: (track_id: string, price: number, platform: PricePlatform) => Promise<void>
  /**
   * 编辑蹲蹲的基本信息（名称 / 品牌 / 主图）。价格不走这里——它由 addPriceRecord
   * 单独追踪并留下历史记录，所以这个 patch 故意只允许非价格字段。
   */
  update: (
    track_id: string,
    patch: Partial<Pick<PriceTrack, 'item_name' | 'brand' | 'image_url'>>,
  ) => Promise<void>
  /** AI-judge whether item_name is the same product as an already-tracked one. */
  findSimilar: (adapter: AIAdapter | null, item_name: string) => Promise<PriceTrack | null>
  /**
   * One-shot intake from the dialog: find-or-create, then record the price.
   * Returns whether it created a new track or updated an existing one.
   */
  intake: (
    adapter: AIAdapter | null,
    item_name: string,
    price: number,
    platform: PricePlatform,
  ) => Promise<{ action: 'created' | 'updated'; track: PriceTrack }>
  /** 不蹲了 — delete the track (records cascade). */
  dismiss: (track_id: string) => Promise<void>
  /** 加入清单 — create a wishlist item from the track, then delete the track. */
  moveToWishlist: (track_id: string) => Promise<void>
  /** Dismiss a Home price-drop card. */
  dismissDrop: (key: string) => void
  /** 设置/清除某个蹲蹲的目标价（蹲蹲 §3）。 */
  setTargetPrice: (track_id: string, target: number | null) => Promise<void>
  /** Dismiss a Home target-hit card. */
  dismissTargetHit: (key: string) => void
}

/** Newest record for a track, or null if it has none. */
function latest(records: PriceRecord[] | undefined): PriceRecord | null {
  return records && records.length > 0 ? records[records.length - 1] : null
}

/** Drop key is (track, newest record) so a fresh lower price re-arms the card. */
function dropKey(trackId: string, recordId: string): string {
  return `${trackId}:${recordId}`
}

/** Strip whitespace/punctuation for the local fallback name match. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_/，,。.·、]+/g, '')
}

export const usePriceTrackStore = create<PriceTrackStore>()(persist((set, get) => ({
  tracks: [],
  records: {},
  dismissedDrops: [],
  dismissedTargets: [],
  loaded: false,

  load: async () => {
    const { data: tracks } = await db
      .from('price_tracks')
      .select('*')
      .order('created_at', { ascending: false })

    const trackList = (tracks as PriceTrack[]) ?? []

    const { data: recs } = await db
      .from('price_records')
      .select('*')
      .order('recorded_at', { ascending: true })

    const byTrack: Record<string, PriceRecord[]> = {}
    for (const r of (recs as PriceRecord[]) ?? []) {
      ;(byTrack[r.price_track_id] ??= []).push(r)
    }

    set({ tracks: trackList, records: byTrack, loaded: true })
  },

  add: async (item_name, price, platform) => {
    const user_id = await getCurrentUserId()
    const { data: track, error } = await db
      .from('price_tracks')
      .insert({
        item_name,
        platform,
        current_price: price,
        last_checked_at: new Date().toISOString(),
        user_id,
      })
      .select()
      .single()
    if (error || !track) throw new Error(error?.message ?? '新建蹲蹲失败')

    const { data: rec } = await db
      .from('price_records')
      .insert({ price_track_id: track.id, price, is_manual: true, user_id })
      .select()
      .single()

    set({
      tracks: [track as PriceTrack, ...get().tracks],
      records: { ...get().records, [track.id]: rec ? [rec as PriceRecord] : [] },
    })
    return track as PriceTrack
  },

  addPriceRecord: async (track_id, price, platform) => {
    const user_id = await getCurrentUserId()
    const now = new Date().toISOString()

    const { data: rec, error } = await db
      .from('price_records')
      .insert({ price_track_id: track_id, price, is_manual: true, user_id })
      .select()
      .single()
    if (error || !rec) throw new Error(error?.message ?? '记录价格失败')

    // Keep the track's denormalised current_price / platform in sync.
    await db
      .from('price_tracks')
      .update({ current_price: price, platform, last_checked_at: now })
      .eq('id', track_id)

    set({
      tracks: get().tracks.map((t) =>
        t.id === track_id ? { ...t, current_price: price, platform, last_checked_at: now } : t,
      ),
      records: {
        ...get().records,
        [track_id]: [...(get().records[track_id] ?? []), rec as PriceRecord],
      },
    })
  },

  update: async (track_id, patch) => {
    const { error } = await db.from('price_tracks').update(patch).eq('id', track_id)
    if (error) throw new Error(error.message || '保存失败')
    set({
      tracks: get().tracks.map((t) => (t.id === track_id ? { ...t, ...patch } : t)),
    })
  },

  findSimilar: async (adapter, item_name) => {
    const tracks = get().tracks
    if (tracks.length === 0) return null

    // Cheap local pass first — exact normalised match only. Catches the common
    // "same screenshot again" case without an AI call; anything fuzzier (different
    // wording for the same product) is left to the AI below, since loose
    // containment would wrongly merge e.g. "鞋" into "耐克跑鞋".
    const target = normalize(item_name)
    const local = tracks.find((t) => normalize(t.item_name) === target)
    if (local) return local

    if (!adapter) return null

    // Ask the AI to pick the matching track by id, or NONE. Same product = same
    // model even if the wording differs ("耐克跑鞋" vs "Nike Air Max 跑步鞋").
    const list = tracks.map((t, i) => `${i + 1}. [${t.id}] ${t.item_name}`).join('\n')
    const messages: AIMessage[] = [
      {
        role: 'system',
        content:
          '你判断一个商品是否与已蹲列表中的某个是"同款"（同一商品，措辞可不同）。只返回该商品的 id 字符串；若都不是同款，只返回 NONE。不要解释。',
      },
      { role: 'user', content: `新商品：${item_name}\n\n已蹲列表：\n${list}` },
    ]

    try {
      const raw = (await adapter.streamChat(messages, () => {})).trim()
      const id = raw.replace(/^```.*$/gm, '').replace(/[`"']/g, '').trim()
      if (!id || /^none$/i.test(id)) return null
      return tracks.find((t) => t.id === id) ?? null
    } catch {
      return null // AI hiccup → treat as new, never block the intake
    }
  },

  intake: async (adapter, item_name, price, platform) => {
    const existing = await get().findSimilar(adapter, item_name)
    if (existing) {
      await get().addPriceRecord(existing.id, price, platform)
      // Re-read the freshly updated track from state.
      const track = get().tracks.find((t) => t.id === existing.id) ?? existing
      return { action: 'updated', track }
    }
    const track = await get().add(item_name, price, platform)
    if (!track) throw new Error('新建蹲蹲失败')
    return { action: 'created', track }
  },

  dismiss: async (track_id) => {
    await db.from('price_tracks').delete().eq('id', track_id)
    const records = { ...get().records }
    delete records[track_id]
    set({ tracks: get().tracks.filter((t) => t.id !== track_id), records })
  },

  moveToWishlist: async (track_id) => {
    const track = get().tracks.find((t) => t.id === track_id)
    if (!track) return

    await db.from('wishlist_items').insert({
      item_name: track.item_name,
      estimated_price: track.current_price,
      season_tag: 'year_round',
      priority: 0,
      status: 'active',
      user_id: await getCurrentUserId(),
    })

    await get().dismiss(track_id)
  },

  dismissDrop: (key) => {
    if (get().dismissedDrops.includes(key)) return
    set({ dismissedDrops: [...get().dismissedDrops, key] })
  },

  setTargetPrice: async (track_id, target) => {
    await db.from('price_tracks').update({ target_price: target }).eq('id', track_id)
    set({
      tracks: get().tracks.map((t) => (t.id === track_id ? { ...t, target_price: target } : t)),
    })
  },

  dismissTargetHit: (key) => {
    if (get().dismissedTargets.includes(key)) return
    set({ dismissedTargets: [...get().dismissedTargets, key] })
  },
}), {
  name: 'kura-price-track',
  storage: createJSONStorage(() => localStorage),
  // Persist the dismissed-drop set across reloads; tracks/records re-hydrate from DB.
  partialize: (s) => ({ dismissedDrops: s.dismissedDrops, dismissedTargets: s.dismissedTargets }),
}))

/**
 * Derive the active (undismissed) price drops from current store state. A drop
 * exists when a track's newest record is strictly lower than the one before it.
 */
export function activeDrops(
  state: Pick<PriceTrackStore, 'tracks' | 'records' | 'dismissedDrops'>,
): PriceDrop[] {
  const out: PriceDrop[] = []
  for (const track of state.tracks) {
    const recs = state.records[track.id]
    if (!recs || recs.length < 2) continue
    const last = recs[recs.length - 1]
    const prev = recs[recs.length - 2]
    if (last.price >= prev.price) continue
    const key = dropKey(track.id, last.id)
    if (state.dismissedDrops.includes(key)) continue
    out.push({ track, key, from: prev.price, to: last.price, diff: prev.price - last.price })
  }
  return out
}

export { dropKey, latest }

/** A tracked item at/under its user-set target price — worth a Home push (蹲蹲 §3). */
export interface TargetHit {
  track: PriceTrack
  /** Stable key (track + newest record); dismissed per key so a new lower record re-arms it. */
  key: string
  current: number
  target: number
}

/**
 * Derive active (undismissed) target-price hits: a track whose newest record price
 * is at or below its target_price. No target → never fires.
 */
export function activeTargetHits(
  state: Pick<PriceTrackStore, 'tracks' | 'records' | 'dismissedTargets'>,
): TargetHit[] {
  const out: TargetHit[] = []
  for (const track of state.tracks) {
    if (track.target_price == null) continue
    const recs = state.records[track.id]
    const last = recs && recs.length > 0 ? recs[recs.length - 1] : null
    if (!last) continue
    if (last.price > track.target_price) continue
    const key = dropKey(track.id, last.id)
    if (state.dismissedTargets.includes(key)) continue
    out.push({ track, key, current: last.price, target: track.target_price })
  }
  return out
}
