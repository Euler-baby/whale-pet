import { join } from 'node:path'

export interface RuntimePathOptions {
  isPackaged: boolean
  portableExecutableDir: string | undefined
  argv: readonly string[]
}

/** 显式测试目录优先；开发版和安装版保留既有 Electron 默认目录。 */
export function resolvePortableUserDataPath(options: RuntimePathOptions): string | null {
  const explicitUserData = options.argv.some(
    (arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
  )
  if (explicitUserData || !options.isPackaged || !options.portableExecutableDir) return null
  return join(options.portableExecutableDir, 'data')
}
