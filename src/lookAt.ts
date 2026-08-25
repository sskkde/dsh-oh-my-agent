/**
 * Look-at orchestrator - OmO's multimodal-looker / look_at ported as a
 * prompt orchestrator over DSH's native vision tools.
 *
 * Upstream look_at hands the agent a purpose-tuned vision call. DSH already
 * ships `describe_image` (vision-model call; the image never enters the
 * conversation) and `read_image` (image into context). This module adds the
 * LOOKER'S CRAFT: intent -> a precise, checklist-driven vision prompt plus the
 * exact native-tool invocation to run it with. No vision model is called here.
 *
 * Surface: the `omo_look_at` tool.
 */

export type LookIntent = 'ui-diagnose' | 'chart-read' | 'text-transcribe' | 'compare' | 'general'

export const LOOK_INTENTS: LookIntent[] = ['ui-diagnose', 'chart-read', 'text-transcribe', 'compare', 'general']

interface IntentSpec {
  headline: string
  checklist: string[]
  format: string
  other?: string
}

const SPECS: Record<LookIntent, IntentSpec> = {
  'ui-diagnose': {
    headline: '诊断这张 UI 截图的问题',
    checklist: [
      '布局：对齐/间距/溢出/截断（逐区域指出具体位置）',
      '层级：遮挡、z-order、覆盖层残缺',
      '一致性：字号/颜色/圆角与常见设计系统预期的偏差',
      '可读性：对比度不足的文字、过小点击目标',
      '错误状态：空态/加载态/错误态是否被正确呈现',
    ],
    format: '按"区域 -> 问题 -> 严重度(blocker/major/minor) -> 修复建议"逐条输出',
  },
  'chart-read': {
    headline: '精确读取这张图表的数据与信息',
    checklist: [
      '图表类型与轴：各轴含义、单位、量程',
      '逐系列读数：起点/终点/峰值/谷值/趋势方向（能读出的具体数值都给出）',
      '异常：离群点、断点、异常跳变',
      '标注与图例：完整转录',
    ],
    format: '先一句话总括，再按系列输出结构化读数（值用数值），最后列异常点',
  },
  'text-transcribe': {
    headline: '完整转录这张图片中的全部文字',
    checklist: [
      '保留原始结构（标题/列表/表格/代码块），表格输出为 markdown 表',
      '语言保持原文；无法辨认的字符用 � 标注而不是猜',
      '图片中的 UI chrome（按钮文字、菜单项）也算文字，一并转录',
    ],
    format: '直接输出转录结果，不要评论',
  },
  compare: {
    headline: '对比这两张图片（第二张通过 question 指明路径/URL）',
    checklist: [
      '先各自一句话描述，再逐区域对比差异',
      '语义差异（内容不同）与渲染差异（样式不同）分开列',
      '判断哪张更新/更正确（若可判断）并给依据',
    ],
    format: '输出"仅图 A 有 / 仅图 B 有 / 两者不同 / 相同"四组清单',
    other: '被对比的第二张图的路径或 URL，写在 question 里',
  },
  general: {
    headline: '完整、客观地描述这张图片',
    checklist: [
      '先整体（类型/主题/构图），再细节（按区域）',
      '可验证的客观描述优先，推断要标"(推测)"',
      '包含一切文字内容（UI 文案/标注/水印）',
    ],
    format: '分层输出：整体 -> 区域细节 -> 文字内容 -> 推断（标注）',
  },
}

export interface LookAtResult {
  ok: boolean
  intent: string
  image: string
  prompt: string
  tool: string
  args: Record<string, string>
  note: string
}

/** Compose the intent-tuned vision prompt + native-tool invocation plan. */
export function lookAt(intent: string, image: string, question: string): LookAtResult {
  const it = (LOOK_INTENTS as string[]).includes(intent) ? (intent as LookIntent) : 'general'
  const spec = SPECS[it]
  const q = question.trim()

  const lines: string[] = []
  lines.push(spec.headline + '。')
  if (q) lines.push(`\n关注点：${q}`)
  lines.push('\n检查清单（逐项过）：')
  for (const c of spec.checklist) lines.push(`- ${c}`)
  if (spec.other && !q) lines.push(`- ${spec.other}`)
  lines.push(`\n输出格式：${spec.format}`)
  lines.push('只描述图中真实可见的内容；看不清的明说看不清，不要编造。')

  return {
    ok: true,
    intent: it,
    image,
    prompt: lines.join('\n'),
    tool: 'describe_image',
    args: { image, prompt: lines.join('\n') },
    note: `把上面生成的 prompt 连同图片传给 describe_image（视觉模型调用，图片不进对话）。若需要图片进入上下文亲自看，用 read_image。intent=${it}${q ? `，关注点已注入` : ''}`,
  }
}
