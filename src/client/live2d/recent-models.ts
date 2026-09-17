import { createElement as h, type ReactElement } from 'react'
import type { Live2DModelSummary } from './library.ts'

export interface Live2DRecentModelsProps {
  readonly models: readonly Live2DModelSummary[]
  readonly busy: boolean
  readonly onSwitch: (model: Live2DModelSummary) => void
  readonly onDelete: (model: Live2DModelSummary) => void
}

/** Accessible recent-model controls, separated so user behavior can be tested without the full widget. */
export function Live2DRecentModels({ models, busy, onSwitch, onDelete }: Live2DRecentModelsProps): ReactElement | null {
  if (models.length === 0) return null
  return h('div', { className: 'wp-live2d-section' },
    h('div', { className: 'wp-live2d-label', id: 'wp-live2d-recent-label' }, '最近使用的模型（最多 5 个）'),
    h('div', { className: 'wp-live2d-model-list', role: 'list', 'aria-labelledby': 'wp-live2d-recent-label' },
      models.map((model) => h('div', { className: 'wp-live2d-model-row', role: 'listitem', key: model.id },
        h('button', {
          className: 'wp-live2d-model-switch',
          type: 'button',
          'aria-pressed': model.active,
          'aria-label': `切换到模型 ${model.name}`,
          'data-live2d-model-id': model.id,
          title: model.active ? '当前模型' : `切换到 ${model.name}`,
          disabled: busy || model.active,
          onClick: () => onSwitch(model),
        },
          h('span', { className: 'wp-live2d-model-name' }, model.name),
          h('span', { className: 'wp-live2d-model-kind' }, model.kind.toUpperCase()),
          model.active && h('span', { className: 'wp-live2d-model-active' }, '当前'),
        ),
        h('button', {
          className: 'wp-live2d-model-delete',
          type: 'button',
          'aria-label': `删除模型 ${model.name}`,
          'data-live2d-delete-id': model.id,
          title: `永久删除 ${model.name}`,
          disabled: busy,
          onClick: () => onDelete(model),
        }, '×'),
      )),
    ),
  )
}
