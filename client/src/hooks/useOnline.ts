import { useSyncExternalStore } from 'react'
import { isOffline, subscribeNetwork } from '../utils/network'

/**
 * 当前是不是离线（含「请求过不去」这种网络层故障）。
 * 组件用它来禁用保存按钮、显示离线灰条。
 */
export function useOnline() {
  const offline = useSyncExternalStore(subscribeNetwork, isOffline, () => false)
  return !offline
}
