/**
 * preload 注入的 `window.pet` 类型声明（renderer 类型入口）
 *
 * renderer 只认 `window.pet: PetApi`；真实注入在 src/preload/index.ts（contextBridge）。
 * 本文件被 tsconfig.web.json 的 include 覆盖，供 src/renderer/** 直接使用。
 */
import type { PetApi } from '@shared/ipc'

declare global {
  interface Window {
    pet: PetApi
  }
}

export {}
