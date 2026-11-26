/**
 * 「只补 extras、不动 token」这条通道的单测。
 *
 * ## 为什么这条通道值得单独钉住
 *
 * Qoder 签到要 `Cosy-MachineToken` + `Cosy-MachineType`，这两个值只能在装了
 * Qoder 桌面端的机器上由 `runtime-info.exe` 生成（Workers 无 `child_process`）。
 * 补字段时若误伤 token，用户不会立刻发现 —— 表现为「签到能过，但对话全部 401」，
 * 而 401 的直觉归因是「账号被封/掉登录」，会把人带到完全错误的方向。
 *
 * 同理，凭据不存在时若回 200，用户会以为已经补上，下次签到仍失败却查不出原因。
 *
 * 运行：`npm test`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * ⚠️ 直接读**原始源码**，不做注释剥离。
 *
 * 试过 `panel.test.ts` 那套 `stripComments`，在本文件里会**误删整段代码**：
 * `src/index.ts` 的注释里有未配对的块注释起始符（示例代码片段），
 * 非贪婪块注释正则会被它带偏，一路吞到后面真正的结束符 —— 结果是
 * 「路由明明在，断言却说找不到」（实测踩到：`slice` 只剩一个换行）。
 *
 * 代价是断言必须挑**注释里不会重复出现**的锚点：下面的锚点都是实际语句
 * （`path === '...'`、`{ ...credential, extras: merged }`），注释里没有。
 *
 * ⚠️ 路径写**相对仓库根**（`src/...`）：单测是打包后从 `.build/tests/` 跑的，
 * `new URL('../src/...', import.meta.url)` 会指到不存在的 `.build/src/`。
 * 脚本由仓库根启动，故 cwd 可靠（与 `panel.test.ts` 同一约定）。
 */
const INDEX = readFileSync('src/index.ts', 'utf8')
const POOL = readFileSync('src/pool/AccountPoolDO.ts', 'utf8')

/** 取路由段落；找不到就抛（`slice(-1)` 会静默返回一个换行，断言就成了摆设）。 */
function routeOf(source: string, from: string, to?: string): string {
  const start = source.indexOf(from)
  assert.ok(start >= 0, `锚点缺失：${from}`)
  const end = to === undefined ? source.length : source.indexOf(to, start)
  return source.slice(start, end === -1 ? source.length : end)
}

test('⚠️ 补 extras 必须整体写回凭据（否则 token 被抹掉 → 签到能过、对话全 401）', () => {
  // 写回的一定是「原凭据 + 新 extras」，不是只写 extras
  assert.match(POOL, /\{\s*\.\.\.credential,\s*extras:\s*merged\s*\}/)
  // 且 extras 是合并而不是替换：替换会丢掉 realm / machineId 这类已有配置
  assert.match(POOL, /\.\.\.existing,\s*\.\.\.patch/)
})

test('⚠️ 凭据不存在必须 404，不许回 200（谎报成功会让下次失败无从排查）', () => {
  const route = routeOf(INDEX, "path === '/admin/credentials/extras'")
  assert.match(route, /result === undefined/)
  assert.match(route, /\b404\b/)
})

test('补 extras 的入参要挡掉空值与非法 key（它们会被当明文 key 落库）', () => {
  const route = routeOf(INDEX, "path === '/admin/credentials/extras'")
  // 空字符串必须拒：否则等于把字段写成空，上游仍然视作「没带」
  assert.match(route, /value\.trim\(\) === ''/)
  // key 必须是标识符形状，不能带控制字符/空白
  assert.match(route, /\^\[A-Za-z\]\[A-Za-z0-9_\]\{0,40\}\$/)
  // uid 是 storage key，要过统一校验（`qodercn:` 前缀形态）
  assert.match(route, /isValidUid\(uid\)/)
})

test('这条通道不得回传 token（与 /admin/* 的既有纪律一致）', () => {
  const route = routeOf(
    INDEX,
    "path === '/admin/credentials/extras'",
    "path === '/admin/pool'",
  )
  assert.ok(!/accessToken\s*:/.test(route), '响应里不得出现 accessToken')
  assert.ok(!/refreshToken\s*:/.test(route), '响应里不得出现 refreshToken')
})
