export type PlanReviewChoice = 'approve' | 'keep' | 'cancelled' | 'unknown'

export function validatePlanMarkdown(plan: string): void {
  if (!plan.trimStart().startsWith('# ')) throw new Error('计划必须是以一级标题 `# ` 开头的完整 Markdown。')
}

export function buildPlanReviewQuestion(plan: string): Record<string, unknown> {
  return {
    id: 'omo-plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave planning mode?',
    detail: plan,
    options: [
      { label: 'Approve', description: '落盘计划工件并切到 Atlas 执行态' },
      { label: 'Keep planning', description: '留在规划态；你的反馈会回到模型' },
    ],
  }
}

export function interpretPlanReviewAnswer(answers: unknown): PlanReviewChoice {
  if (!Array.isArray(answers) || answers.length === 0) return 'cancelled'
  const first = answers[0] as { selected?: unknown; custom?: unknown } | null
  if (!first || typeof first !== 'object') return 'unknown'
  const selected = Array.isArray(first.selected) ? first.selected : []
  if (selected.includes('Approve')) return 'approve'
  if (selected.includes('Keep planning')) return 'keep'
  return 'unknown'
}

export function goalFromPlan(plan: string): string {
  const heading = plan.split(/\r?\n/).find((line) => /^#\s+/.test(line))
  return heading ? heading.replace(/^#\s+/, '').trim() : 'Approved plan'
}
