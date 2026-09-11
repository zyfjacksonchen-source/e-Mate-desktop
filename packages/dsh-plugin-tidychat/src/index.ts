/**
 * dsh-tidychat host 半：注册 settings 命名空间与配置 schema，让「设置 > 插件配置」
 * 面板能可视化开关功能。实际功能全部在浏览器半（exports "./client"）。
 *
 * 本插件宿主侧不消费配置值（仅注册命名空间以暴露给配置面板）；
 * 浏览器半通过 settingsScope 读取同一命名空间并即时生效。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

/** Existing tidychat namespace, registered through the pinned rc7 owner. */
export const TIDYCHAT_SETTINGS_NAMESPACE = 'tidychat' as const

/** 插件配置。 */
export interface Config {
  /** 已完成轮次自动折叠（思考/工具调用/中间文字，只留最终结论）。 */
  fold?: boolean
  /** 思考行与文字之间的分隔线。 */
  divider?: boolean
  /** 左缘 Codex 式用户消息定位条。 */
  navigator?: boolean
  /** 定位条默认色模式：auto（优先宿主淡色文字色，对比不足自动换纠偏灰）/ custom（用 navColorCustom）；gray…red 为历史色系值（兼容保留）。 */
  navColor?: (typeof NAV_HUE_KEYS)[number]
  /** 定位条默认色自定义颜色（navColor = custom 时生效）：任意 CSS 颜色，如 #3b82f6 / rgb(59,130,246) / rgba(59,130,246,0.85)。 */
  navColorCustom?: string
  /** 定位条默认色历史明度档：l1…l5，仅 navColor 为历史色系值时生效（兼容保留）。 */
  navColorLight?: (typeof NAV_LIGHT_KEYS)[number]
  /** 定位条强调色模式：auto（跟随主题品牌色）/ custom（用 navAccentCustom）；gray…red 为历史色系值（兼容保留）。 */
  navAccent?: (typeof NAV_ACCENT_KEYS)[number]
  /** 定位条强调色自定义颜色（navAccent = custom 时生效）：任意 CSS 颜色。 */
  navAccentCustom?: string
  /** 定位条强调色历史明度档：l1…l5，仅 navAccent 为历史色系值时生效（兼容保留）。 */
  navAccentLight?: (typeof NAV_LIGHT_KEYS)[number]
}

/** 定位条默认色模式枚举（auto / custom；gray…red 为历史色系值，兼容保留）。 */
export const NAV_HUE_KEYS = ['auto', 'custom', 'gray', 'black', 'white', 'blue', 'violet', 'cyan', 'green', 'orange', 'red'] as const
/** 定位条强调色模式枚举（auto / custom；gray…red 为历史色系值，兼容保留）。 */
export const NAV_ACCENT_KEYS = ['auto', 'custom', 'gray', 'black', 'white', 'blue', 'violet', 'cyan', 'green', 'orange', 'red'] as const
/** 定位条明度档枚举。 */
export const NAV_LIGHT_KEYS = ['l1', 'l2', 'l3', 'l4', 'l5'] as const

export const Config: z<Config> = z.object({
  fold: z.boolean().default(true),
  divider: z.boolean().default(true),
  navigator: z.boolean().default(true),
  navColor: z.union(NAV_HUE_KEYS).default('auto'),
  navColorCustom: z.string().default(''),
  navColorLight: z.union(NAV_LIGHT_KEYS).default('l3'),
  navAccent: z.union(NAV_ACCENT_KEYS).default('auto'),
  navAccentCustom: z.string().default(''),
  navAccentLight: z.union(NAV_LIGHT_KEYS).default('l3'),
})

export const inject: string[] = []

export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.register(TIDYCHAT_SETTINGS_NAMESPACE, Config, { base: config ?? {} })
  })
}
