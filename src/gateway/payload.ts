/**
 * 出站请求体准备（**纯函数**）。
 *
 * ## 为什么需要这一层
 *
 * OpenAI 客户端发的请求体**不能原样**转给 WorkBuddy 上游，有四处硬性差异
 * （逐条来自 Go 侧实测，AGENTS.md §6）：
 *
 * | 差异 | 后果（若不处理） |
 * |---|---|
 * | 上游**只认 `max_tokens`**，不认 `max_completion_tokens` | 别名被忽略 → 回落默认输出上限（实测 32000）→ **长流被截断** |
 * | 上游要求 **`stream: true`** | 非流式请求被上游按流式处理不当 |
 * | `tool_choice` 只认**字符串** | 对象形式 → **400 code=11101** |
 * | `stream_options.include_usage` 缺省需补 | 末帧不返回 usage → 用量统计恒为 0 |
 *
 * ## 分层纪律
 *
 * 纯函数、无网络、无存储 —— 上游改判据时**只改这个文件**，网关逻辑不动。
 */

/** 需要翻译的字段名（OpenAI 新字段 → 上游认的旧字段）。 */
export function translateMaxCompletionTokens(body: Record<string, unknown>): void {
  const alias = body.max_completion_tokens
  delete body.max_completion_tokens

  // ⚠️ 显式 max_tokens 优先：别名只删不译（避免把别名值覆盖掉用户显式给的值）
  if (body.max_tokens !== undefined) return

  // 只有正整数才翻译。0/null 是「未设置」语义，负数是非法值 —— 都不该变成 max_tokens
  if (typeof alias === 'number' && Number.isSafeInteger(alias) && alias > 0) {
    body.max_tokens = alias
  }
}

/**
 * 归一化 `tool_choice`：上游该字段是 **string**，对象形式会 400 `code=11101`。
 *
 * - `'auto'` / `'none'` / `'required'` → 原样透传；
 * - 对象形式（`{type:'function', function:{name}}`）→ 降级为 `'auto'`（**不是**报错：
 *   降级能让请求成功，报错会让整个对话失败。而具名选择在多数客户端里只影响
 *   偏好，不影响正确性）；
 * - 其他未知形态 → 删除该字段（缺省即 `auto`）。
 */
export function normalizeToolChoice(body: Record<string, unknown>): void {
  const choice = body.tool_choice
  if (choice === undefined) return

  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return
    // 未知字符串：删掉（缺省即 auto），比传给上游被拒好
    delete body.tool_choice
    return
  }

  // 对象形式（含具名函数）：降级为 auto
  delete body.tool_choice
  body.tool_choice = 'auto'
}

/**
 * 补齐 `stream_options.include_usage`。
 *
 * 只有**显式没带**时才补：用户显式设了 `include_usage: false` 就尊重它。
 */
export function ensureStreamOptions(body: Record<string, unknown>): void {
  if (body.stream_options !== undefined) return
  body.stream_options = { include_usage: true }
}

/**
 * 工具配对清理：剔除「孤儿」`tool` 消息与不完整的 `tool_calls`。
 *
 * ## 为什么必须做（Go 侧 `tool_pairing.go` 记录的严重缺陷）
 *
 * OpenAI 规范要求每个 `role:'tool'` 消息都有一个**前序** assistant 消息里的
 * `tool_calls` 与之配对（靠 `tool_call_id`）。
 *
 * 若配对不完整，上游会**对之后每条消息都返 400** ——
 * 也就是整条会话报废，且错误信息不指出是哪个字段。
 *
 * 客户端在中断/重试/切模型时很容易产生孤儿 tool 消息，故必须先行清理。
 *
 * @returns 清理后的消息数组（无改动时返回原数组）
 */
export function cleanupToolPairing(messages: unknown[]): unknown[] {
  // 第一遍：收集所有 assistant 消息声明的 tool_call id
  const declared = new Set<string>()
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const msg = raw as Record<string, unknown>
    if (msg.role !== 'assistant') continue
    const calls = msg.tool_calls
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (call === null || typeof call !== 'object') continue
      const id = (call as Record<string, unknown>).id
      if (typeof id === 'string' && id !== '') declared.add(id)
    }
  }

  const out: unknown[] = []
  let changed = false

  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') {
      out.push(raw)
      continue
    }
    const msg = raw as Record<string, unknown>

    // ⚠️ **丢弃 `role: 'developer'` 消息**（实测缺陷，用户报两处 11128）。
    //
    // ## 为什么必须丢
    //
    // OpenAI 的**新**规范引入了 `developer` 角色，而**上游只认**
    // `system` / `user` / `assistant` / `tool`。
    // 实测：pi（`pi-coding-agent`）把系统提示词放在
    // `{role:'developer', content:'You are an expert coding assistant…'}` 里，
    // 我们原样转发 ⇒ 上游判定「首条不是 system」⇒ 国际版回
    // `11128 Illegal API invocation from an unapproved channel`
    //（而 `displayMsg` 把它**伪装成「安全策略拦截」**，极易误判成账号被封）。
    //
    // ## 为什么是「丢弃」而不是「改名为 system」
    //
    // 参考实现（`deepseek-harness-codearts/src/message-shape.ts:99,125`）的做法
    // 就是**丢弃**，理由写得明确：
    // > `role:'developer'` 只承载工具增删元数据（`tool-addition` / `tool-removal`），
    // > 不是对话内容。
    //
    // ⚠️ 而 pi 那条 developer **确实承载了系统提示词**，丢掉会让模型失去行为约束。
    // 故这里比参考实现**多做一步**：内容非空时**降级为 `system`**（保住语义），
    // 只有空内容才真正丢弃。这样两种来源（元数据 / 真提示词）都得到正确处理。
    if (msg.role === 'developer') {
      const content = msg.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => {
              const o = b as Record<string, unknown> | null
              return o !== null && typeof o === 'object' && typeof o.text === 'string' ? o.text : ''
            }).join('')
          : ''
      changed = true
      if (text.trim() === '') continue // 纯元数据 ⇒ 丢弃
      // 有真实内容 ⇒ 降级为 system（保住提示词语义）
      out.push({ role: 'system', content: msg.content })
      continue
    }

    // 剔除孤儿 tool 消息（tool_call_id 未被子集声明）
    if (msg.role === 'tool') {
      const id = msg.tool_call_id
      if (typeof id !== 'string' || id === '' || !declared.has(id)) {
        changed = true
        continue // 丢弃
      }
    }

    // 剔除 assistant 消息里**名字为空**的 tool_call（Go 侧记录过它跨 provider 传染）
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const kept = (msg.tool_calls as unknown[]).filter((call) => {
        if (call === null || typeof call !== 'object') return false
        const c = call as Record<string, unknown>
        const fn = c.function
        if (fn === null || typeof fn !== 'object') return false
        const name = (fn as Record<string, unknown>).name
        // ⚠️ 名称为空的 tool_call 会让整条会话报废（上游报 11133 且不指出字段）
        return typeof name === 'string' && name !== ''
      })
      if (kept.length !== msg.tool_calls.length) {
        changed = true
        if (kept.length === 0) {
          delete msg.tool_calls
        } else {
          msg.tool_calls = kept
        }
      }
    }

    out.push(msg)
  }

  return changed ? out : messages
}

/** 准备结果。 */
export interface PrepareResult {
  body: string
  /** 做过的改写（供日志与排查）。 */
  applied: string[]
}

/**
 * 完整准备管线。
 *
 * ⚠️ 顺序即语义：先翻译字段名（影响后续判断），再清理工具配对
 * （配对错误会让整个请求失败，必须最先修好内容），最后按角色做渠道指纹脱敏。
 */
/**
 * 请求里**是否带图片**（纯函数）。
 *
 * ## 为什么需要它
 *
 * 用户报「为什么自动 DeepSeek 模型不支持图像识别」。查下来：
 * 渠道 `codearts` 的 DeepSeek **确实不支持图片**，而聚合目录此前用
 * 「全部候选都支持才算支持」的保守口径 ⇒ 整个规范名被标成不支持。
 *
 * ⚠️ 单纯把口径改成「任一支持」是**错的** —— 聚合会随机挑渠道，
 * 带图请求有概率落到 `codearts` 上并**被上游拒绝**（随机失败比明确不支持更糟）。
 *
 * ⇒ 正确做法是把能力判断**下沉到路由**：带图请求时**只发给支持图片的渠道**。
 * 这样目录可以如实说「支持」（确实有渠道能处理），且不会随机失败。
 *
 * ## 判据（照 OpenAI 规范）
 *
 * `messages[].content` 有两种形态：
 * - **字符串** —— 纯文本，不可能带图；
 * - **数组** —— 部件列表，`{type: 'image_url'}` 即一张图片。
 *
 * ⚠️ 只认 `image_url`：`input_image` 是 Responses API 的部件名，到 chat 体时
 * 已被 `responses.ts` 转成 `image_url`（那里有单测钉住）。
 * ⚠️ 不按 URL 下载任何东西（本项目不实现 SSRF，见 AGENTS.md §7.1）。
 */
export function requestHasImage(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const messages = (body as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return false
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const content = (raw as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      if (rec.type === 'image_url') return true
    }
  }
  return false
}

export function prepareChatBody(input: unknown): PrepareResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const body = { ...(input as Record<string, unknown>) }
  const applied: string[] = []

  // ① 强制 stream（上游要求）
  if (body.stream !== true) {
    body.stream = true
    applied.push('stream=true')
  }

  // ② max_completion_tokens → max_tokens
  if (body.max_completion_tokens !== undefined) {
    translateMaxCompletionTokens(body)
    applied.push('max_completion_tokens→max_tokens')
  }

  // ③ stream_options 补默认
  if (body.stream_options === undefined) {
    ensureStreamOptions(body)
    applied.push('stream_options.include_usage')
  }

  // ④ tool_choice 归一化（对象形式会 400）
  if (body.tool_choice !== undefined) {
    const before = typeof body.tool_choice
    normalizeToolChoice(body)
    if (before === 'object') applied.push('tool_choice→auto')
  }

  // ⑤ 工具配对清理（不完整配对会让之后每条消息都 400）
  if (Array.isArray(body.messages)) {
    const cleaned = cleanupToolPairing(body.messages)
    if (cleaned !== body.messages) {
      body.messages = cleaned
      applied.push('tool-pairing')
    }
  } else {
    throw new Error('messages 必须是数组')
  }

  // ⑥ 渠道指纹脱敏（**必须排在 ⑤ 之后**：`developer` 要先被降级成 `system`，
  // 那条消息里的指纹才会被 `DISGUISED_ROLES` 覆盖到）
  const disguised = disguiseMessages(body.messages as unknown[])
  if (disguised.changed) {
    body.messages = disguised.messages
    applied.push('disguise')
  }

  return { body: JSON.stringify(body), applied }
}

/**
 * 渠道指纹脱敏（AGENTS.md §6.6）。
 *
 * 上游会**按请求体里的固定句式识别客户端渠道**，认出「未授权渠道」就回
 * `11128 Illegal API invocation from an unapproved channel`
 *（`displayMsg` 把它伪装成「安全策略拦截」，极易误判成账号被封）。
 *
 * ## 🔴 教训：`\s` 匹配不到零宽空格，规则「写对了却从不触发」
 *
 * 运行时把产品名写成 `DeepSeek` + **U+200B（零宽空格）** + ` Harness`。
 * 而 JS 的 `\s` **不含 `U+200B`**（它只在 `\uFEFF` / `\u00A0` / `\u2000-200A`
 * 这些上成立）⇒ 用 `\s+` 写的旧规则在真实 DSH 请求上**一次都没命中过**，
 * 请求原样发出、照样被拦，而单测用普通空格构造的字符串**永远是通过的**。
 *
 * 实测（本机，2026-11-24，同一账号同一模型，只改首条 system 内容）：
 *
 * | 首条 system 内容 | 结果 |
 * |---|---|
 * | `…powered by DeepSeek Harness.`（普通空格） | ✅（旧规则改写了它） |
 * | `…powered by DeepSeek\u200B Harness.`（零宽空格） | ❌ 11128 |
 * | `…DeepSeek\u200B Harness…`（零宽空格，**不在开头**） | ✅ |
 * | `Tokens prefixed with @ are paths…` | ❌ 11128 |
 * | `You are Claude Code, Anthropic's official CLI for Claude.` | ❌ 11128 |
 * | 以上全部换成 `DeepSeek-Harness` / `(at)` / `an official CLI` 的写法 | ✅ |
 *
 * 两条结论：
 * 1. 判据是**精确子串**（大小写不敏感、**任意不可见分隔符**容错），不是语义；
 * 2. 身份句只在**消息开头**（偏移 0）被判 —— 同一句挪到中间就放行。
 *    我们仍**故意全局替换**：改写是语义等价的、幂等的，宁可多改不漏改。
 *
 * ## 不收录的候选（实测**不**触发，别凭直觉加）
 *
 * `x-anthropic-billing-header`、`To give feedback, users should report…`、
 * Codex CLI 的开场白、`Web GUI` 那两句、`You are a coding agent powered by …`、
 * 单独出现的 `DeepSeek Harness`（非身份句）—— 逐个发过去都是 200。
 *
 * 参考实现（`WorkBuddy-Hub-Android` 的 `ApiAdapters.disguise`）把这些全改了，
 * 因为它对着的是另一个网关版本；**我们只按自己实测到的判据改**，
 * 免得把用户提示词改得面目全非。
 */

/**
 * 上游眼里的「分隔符」，而字面比较看不见的那一类。
 *
 * `\u200B` 零宽空格 / `\u2060` word-joiner / `\uFEFF` BOM / `\u00A0` 不换行空格。
 * ⚠️ 判据里**必须**带上它们，否则规则对真实运行时写的文本永不生效。
 */
const GAP = '[\\s\\u00A0\\u200B\\u2060\\uFEFF]'

/** 身份句：`You are an AI agent powered by DeepSeek Harness`。 */
const IDENTITY_SIGNATURE = new RegExp(
  `You${GAP}+are${GAP}+an${GAP}+AI${GAP}+agent${GAP}+powered${GAP}+by${GAP}+DeepSeek${GAP}*Harness`,
  'gi',
)

/**
 * 客户端系统提示里会被判成「未授权渠道」的固定片段。
 *
 * 每条都只动**最小的一处措辞**，句子对模型的意思不变：
 * `powered by`→`running on`、`@`→`(at)`、少一个 `the` 换成 `an`。
 * 替换文本本身不能再命中任何一条（保证幂等，重试多少次结果都一样）。
 */
const CHANNEL_SIGNATURES: Array<{ pattern: RegExp; replacement: string }> = [
  // ① DSH 运行时的自我描述（**必须用 GAP**，见上方教训）
  {
    pattern: IDENTITY_SIGNATURE,
    replacement: 'You are an AI agent running on DeepSeek Harness',
  },
  // ② 编码 agent 的 `@` 引用说明。实测**位置无关**，出现在 27 KB 提示词中间也拦。
  { pattern: /Tokens prefixed with @/gi, replacement: 'Tokens prefixed with (at)' },
  // ③ Claude Code 的开场白（Anthropic 生态客户端发的系统提示）
  {
    pattern: /You are Claude Code, Anthropic's official CLI for Claude\./gi,
    replacement: "You are Claude Code, an official CLI for Claude.",
  },
]

/**
 * 上游会读的角色。
 *
 * 整段对话都在扫描范围里（回放的历史 assistant 消息同样会被判），
 * 但 `user` **不在内** —— 用户写的话是数据，上游也不按它判定；
 * 改写用户内容属于「改了用户问的是什么」，收益为零、风险非零。
 *
 * ⚠️ `developer` 不用列：`cleanupToolPairing` 已把它降级成 `system`。
 */
const DISGUISED_ROLES = new Set(['system', 'assistant'])

/** 改写一段文本里所有被拦的指纹（纯函数、幂等）。 */
export function disguiseText(text: string): string {
  if (text === '') return text
  let out = text
  for (const { pattern, replacement } of CHANNEL_SIGNATURES) {
    // `g` 正则的 `lastIndex` 会跨调用残留；`replace` 对全局正则内部会先复位，
    // 但显式复位一次不花什么钱，且避免以后有人改成 `test()` 时踩坑。
    pattern.lastIndex = 0
    out = out.replace(pattern, replacement)
  }
  return out
}

/** 是否需要改写（快速子串预筛，避免对每条消息都跑正则）。 */
function needsDisguise(text: string): boolean {
  return (
    text.includes('Tokens prefixed with @') ||
    text.includes('x-anthropic-billing-header') ||
    text.includes('You are Claude Code') ||
    /DeepSeek[\s\u00A0\u200B\u2060\uFEFF]*Harness/i.test(text)
  )
}

/**
 * 按角色逐条脱敏（对象级，能区分 `system` / `user`）。
 *
 * `content` 两种形态都要处理：字符串，或部件列表（`[{type:'text',text}]`）——
 * 后者漏掉的话，客户端换个写法就绕过了规则，等于没做。
 *
 * @returns 有改动时返回新数组（**不原地改**调用方的消息对象）
 */
export function disguiseMessages(messages: unknown[]): {
  messages: unknown[]
  changed: boolean
} {
  let changed = false
  const out = messages.map((raw) => {
    if (raw === null || typeof raw !== 'object') return raw
    const msg = raw as Record<string, unknown>
    if (typeof msg.role !== 'string' || !DISGUISED_ROLES.has(msg.role)) return msg

    const content = msg.content
    if (typeof content === 'string') {
      if (!needsDisguise(content)) return msg
      const next = disguiseText(content)
      if (next === content) return msg
      changed = true
      return { ...msg, content: next }
    }

    if (Array.isArray(content)) {
      let touched = false
      const parts = content.map((part) => {
        if (part === null || typeof part !== 'object') return part
        const rec = part as Record<string, unknown>
        const text = rec.text
        if (typeof text !== 'string' || !needsDisguise(text)) return part
        const next = disguiseText(text)
        if (next === text) return part
        touched = true
        return { ...rec, text: next }
      })
      if (!touched) return msg
      changed = true
      return { ...msg, content: parts }
    }

    return msg
  })
  return { messages: changed ? out : messages, changed }
}

/**
 * 反探测脱敏（AGENTS.md §6.6），**串级**。
 *
 * 裸数字 `11128` 出现在请求体里**本身就是拦截条件**，必须改写。
 * 零宽空格无效（上游会归一化），故插入连字符。
 *
 * ⚠️ 句式级的指纹改写**不在这里**，而在 `prepareChatBody` 的 ⑥ 步
 * （`disguiseMessages`）—— 那里拿得到**角色**，才可能只改
 * `system`/`assistant` 而不碰用户原话。此处只做这个不分角色的数字替换。
 */
export function sanitizeChatBody(body: string): string {
  return body.includes('11128') ? body.replaceAll('11128', '11-128') : body
}
