/**
 * 启动闪屏（React 版）。
 *
 * index.html 里那块内联的闪屏只负责"JS 还没到"的那几十毫秒；等 JS 起来、
 * 开始校验登录态时，这块接着顶上去 —— 样子和内联那块一模一样（白底 + logo +
 * 「木材进销存管理系统」），所以交接的时候用户看不出来换了人。
 *
 * 校验完就卸载，页面直接露出来，不再有"一屏灰底 + 一个小转圈"的空窗。
 */
export default function BootSplash() {
  return (
    <div className="boot-splash">
      <div className="boot-splash-inner">
        <img src="/logo.png" alt="" />
        <p>木材进销存管理系统</p>
      </div>
    </div>
  )
}
