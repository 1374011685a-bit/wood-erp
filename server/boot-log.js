import fs from 'node:fs'

/**
 * 启动日志兜底模块 —— 必须被 server/index.js 当作「第一个 import」引入。
 *
 * 背景：容器里 stdout/stderr 走管道（非 TTY）时是异步写入的，process.exit() 会把
 * 还没 flush 的内容丢掉；而模块加载阶段的异常又发生在业务代码挂兜底之前。
 * 所以这里在做任何其它事情之前，先同步写一行日志并挂上兜底处理器。
 */

/**
 * 同步往 stdout + stderr 各写一行：
 * - 同步写：绕过异步缓冲，process.exit() 之前也一定落盘
 * - 两个流都写：有的平台日志页只抓 stdout、有的只抓 stderr，都写就不会整页空白
 */
export function writeLog(message) {
  for (const fd of [1, 2]) {
    try {
      fs.writeSync(fd, `${message}\n`)
    } catch {
      // 这个流写不出去就跳过
    }
  }
}

writeLog(
  `[boot] node=${process.version} pid=${process.pid} cwd=${process.cwd()} ` +
    `cwd存在=${fs.existsSync(process.cwd())}`,
)

// 尽早挂兜底：连「模块加载失败」这种早期异常也能留下中文日志
process.on('uncaughtException', (err) => {
  writeLog(`[启动失败] 未捕获异常：${err?.stack ?? err}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  writeLog(`[启动失败] 未处理的 Promise 异常：${reason?.stack ?? reason}`)
  process.exit(1)
})
