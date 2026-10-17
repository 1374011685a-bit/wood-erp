/**
 * 路由分流（第 2 刀）。
 *
 * 手机端（≤767px）访问**白名单**路径 → 换成 MobileLayout（顶栏 + 底部 Tab + 安全区）；
 * 其它路径、以及桌面端任何宽度 → 原样走老 Layout。
 *
 * ⚠️ 白名单现在只有 3 个入口：首页 / 入库（列表 + 表单）/ 出库（列表 + 表单）。
 *    其余 12 个页面继续用老渲染，等 Mobile 版写完再一个个加进来 —— 这样手机端
 *    任何时刻都是**可用**的，不会出现半迁移的白屏。
 * ⚠️ 桌面端（≥768px）永远返回老 Layout，所以桌面端一个像素都不会变。
 */
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import Layout from '../components/Layout'
import MobileLayout from './MobileLayout'

/**
 * 白名单：**只放已经有 Mobile 实现的页面**。
 * 今晚先上首页；入库 / 出库的 Mobile 版一落地，就往这里各加两行
 * （'/inbound'、'/inbound/new'、'/outbound'、'/outbound/new'）。
 * 没实现的页面先留在老树里，手机端也不会出现"外壳套外壳"的重复栏。
 */
const WHITELIST = [
  '/',
  '/documents',
  '/inbound',
  '/inbound/new',
  '/outbound',
  '/outbound/new',
  '/stock',
  '/records',
]

/** 视口是不是手机尺寸（和现有 CSS 的 767px 断点一个口径） */
export function useIsMobileViewport() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener('change', onChange)
    setMobile(query.matches)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return mobile
}

export function isMobileWhitelisted(pathname: string) {
  return WHITELIST.includes(pathname)
}

export default function ShellSwitch() {
  const location = useLocation()
  const mobile = useIsMobileViewport()
  if (mobile && isMobileWhitelisted(location.pathname)) return <MobileLayout />
  return <Layout />
}
