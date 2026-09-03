/**
 * Live2D 动态 chunk 入口：widget 仅在需要时 `import()` 本文件（经宿主
 * `/dsh-whale-pet-live2d.js` 静态路由），把 pixi + Cubism 运行时检查
 * 隔离在当前 bundle 之外。
 */
export { mountLive2D } from './core.ts'
export type { Live2DHandle } from './core.ts'
export type { StoredModel } from './parse.ts'