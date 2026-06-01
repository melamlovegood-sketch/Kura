export type CategoryMain = 'basic_life' | 'discretionary'

export type ItemCategory =
  | 'canteen'
  | 'transport'
  | 'daily_supplies'
  | 'subscription'
  | 'daily'
  | 'online_shopping'
  | 'entertainment'
  | 'other'

export type SubscriptionCategory = 'streaming' | 'tools' | 'transport' | 'other'

export type SeasonTag = 'year_round' | 'summer' | 'winter' | 'specific'

// ─── Parsed (from AI) ─────────────────────────────────────────────────────────

export interface ParsedTransaction {
  amount: number
  description: string
  category: ItemCategory
  category_main: CategoryMain
  date: string
  /** Optional shelf-life / expiry date (YYYY-MM-DD) for perishables. */
  expiry_date?: string | null
}

export interface ParsedBudget {
  month: string
  basic_life_limit: number | null
  discretionary_limit: number | null
  total_income: number | null
}

export interface ParsedImpulse {
  item_name: string
  estimated_price: number | null
  season_tag: SeasonTag
  source: string | null
}

export interface ParsedWishlistItem {
  item_name: string
  estimated_price: number | null
  category: string | null
  season_tag: SeasonTag
  need_intensity: number | null
  worthiness_score: number | null
  worthiness_reason: string | null
}

export interface ParsedSavings {
  amount: number
  description: string
}

export interface ParsedSubscription {
  name: string
  amount: number
  billing_day: number
  category: SubscriptionCategory
}

// ─── DB rows ──────────────────────────────────────────────────────────────────

export interface BudgetData {
  id: string
  month: string
  basic_life_limit: number
  discretionary_limit: number
  basic_life_used: number
  discretionary_used: number
  total_income: number | null
  note: string | null
}

export interface ImpulseRecord {
  id: string
  item_name: string
  estimated_price: number | null
  season_tag: SeasonTag
  source: string | null
  recorded_at: string
  expires_at: string
  status: 'pending' | 'approved' | 'dismissed'
}

export interface WishlistItem {
  id: string
  item_name: string
  category: string | null
  estimated_price: number | null
  season_tag: SeasonTag
  priority: number
  need_intensity: number | null
  worthiness_score: number | null
  worthiness_reason: string | null
  is_focus: boolean
  last_nudged_at: string | null
  status: 'active' | 'purchased' | 'dismissed'
  impulse_record_id: string | null
  added_at: string
  // 详情页字段（迁移 0019）：主图 + 商品属性 + 备注，均可内联编辑 / AI 截图回填。
  image_url: string | null
  brand: string | null
  fabric: string | null
  color: string | null
  size: string | null
  channel: string | null
  notes: string | null
}

export interface Subscription {
  id: string
  name: string
  amount: number
  billing_day: number
  category: SubscriptionCategory
  is_active: boolean
  created_at: string
}

export interface WishPoolData {
  id: string
  focus_item_id: string
  focus_item_name: string
  target_amount: number
  saved_amount: number
  completed_at: string | null
}

// ─── 蹲蹲 / price tracking ─────────────────────────────────────────────────────

/** Platform a tracked price came from. AI infers it from the screenshot/text. */
export type PricePlatform = 'taobao' | 'jd' | 'dewu' | 'other'

export interface PriceTrack {
  id: string
  wishlist_item_id: string | null
  item_name: string
  target_price: number | null
  current_price: number | null
  source_url: string | null
  platform: PricePlatform
  last_checked_at: string | null
  created_at: string
}

export interface PriceRecord {
  id: string
  price_track_id: string
  price: number
  is_manual: boolean
  recorded_at: string
}

/** What the AI pulls out of a "蹲一下价格" input. */
export interface ParsedPriceTrack {
  item_name: string
  price: number | null
  platform: PricePlatform
}

export interface BudgetPlan {
  id: string
  month: string
  basic_life_limit: number | null
  discretionary_limit: number | null
  reason: string | null
  status: 'pending' | 'applied' | 'dismissed'
}

export interface ParsedBudgetUpdate {
  scope: CategoryMain
  limit: number
  label: string
}
