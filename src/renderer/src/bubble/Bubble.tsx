/**
 * 气泡（PLAN §6 窗口口径：气泡区 300×140；03 §8：圆角 12px、最大宽 280、字号 13px）
 *
 * 0.4.2：新增 `reminder` 变体——任务提醒用大标题/强调色/轻微 pulse，
 * 并带「打开任务清单」「关闭」两个动作按钮；整体仍限制在 300×140 气泡区内。
 * App 侧提醒卡与 HUD 二选一渲染（带 action 的气泡优先），不会互相遮挡。
 */
export type BubbleVariant = 'line' | 'error' | 'reminder'

export interface BubbleProps {
  text: string
  variant?: BubbleVariant
  onClose: () => void
  onAction?: (() => void) | undefined
}

export default function Bubble({ text, variant = 'line', onClose, onAction }: BubbleProps) {
  if (variant === 'reminder') {
    return (
      <div className="bubble bubble--reminder" role="alert">
        <span className="bubble__eyebrow">任务提醒</span>
        <strong className="bubble__title">{text}</strong>
        <div className="bubble__actions">
          {onAction !== undefined ? (
            <button
              type="button"
              className="bubble__action bubble__action--primary"
              onClick={onAction}
            >
              打开任务清单
            </button>
          ) : null}
          <button
            type="button"
            className="bubble__action bubble__action--ghost"
            onClick={onClose}
            aria-label="关闭提醒"
          >
            关闭
          </button>
        </div>
      </div>
    )
  }
  if (onAction !== undefined) {
    return (
      <div className={`bubble bubble--${variant}`}>
        <span className="bubble__text">{text}</span>
        <div className="bubble__actions">
          <button type="button" onClick={onAction}>
            打开任务清单
          </button>
          <button type="button" onClick={onClose} aria-label="关闭提醒">
            关闭
          </button>
        </div>
      </div>
    )
  }
  return (
    <button
      type="button"
      className={`bubble bubble--${variant}`}
      onClick={onClose}
      title="点击关闭"
    >
      <span className="bubble__text">{text}</span>
    </button>
  )
}
