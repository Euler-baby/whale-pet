/**
 * 项目新建/编辑模态弹窗（0.4；docs/36 §4）
 *
 * - 使用原生 <dialog> 模态，遮罩不改变底层列表尺寸；Esc/取消关闭
 * - 名称去空白 1–40 字、备注 ≤200 字；重名由 main 校验并回显行内错误
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { PROJECT_NAME_MAX, PROJECT_NOTE_MAX } from '@shared/tasks'
import type { Project } from '@shared/types'

interface ProjectFormProps {
  mode: 'create' | 'edit'
  project?: Project
  /** 抛错时弹窗保留输入并显示错误；成功后由父组件关闭 */
  onSubmit: (name: string, note: string) => Promise<void>
  onCancel: () => void
}

export default function ProjectForm({ mode, project, onSubmit, onCancel }: ProjectFormProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(project?.name ?? '')
  const [note, setNote] = useState(project?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setError('请先输入项目名称')
      return
    }
    if (trimmedName.length > PROJECT_NAME_MAX) {
      setError(`项目名称不能超过 ${PROJECT_NAME_MAX} 字`)
      return
    }
    const trimmedNote = note.trim()
    if (trimmedNote.length > PROJECT_NOTE_MAX) {
      setError(`项目备注不能超过 ${PROJECT_NOTE_MAX} 字`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmedName, trimmedNote)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'create' ? '新建项目' : '编辑项目'

  return (
    <dialog
      ref={dialog}
      className="modal project-modal"
      aria-labelledby="project-form-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <form className="modal__body" onSubmit={(event) => void submit(event)}>
        <h2 id="project-form-title" className="modal__title">
          {title}
        </h2>
        <label className="field">
          <span className="field__label">项目名称</span>
          <input
            autoFocus
            value={name}
            maxLength={PROJECT_NAME_MAX}
            placeholder="例如：线性代数复习"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value)
              if (error !== null) setError(null)
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">项目备注（可选）</span>
          <textarea
            rows={3}
            value={note}
            maxLength={PROJECT_NOTE_MAX}
            placeholder="目标、资料或范围说明"
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <p className="modal__hint">
          名称最多 {PROJECT_NAME_MAX} 字；备注最多 {PROJECT_NOTE_MAX} 字。
        </p>
        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal__actions">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? '保存中…' : mode === 'create' ? '创建项目' : '保存项目'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
