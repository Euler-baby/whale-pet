import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolvePortableUserDataPath } from '../../src/main/platform/runtime-paths'

describe('resolvePortableUserDataPath', () => {
  const portable = {
    isPackaged: true,
    portableExecutableDir: join('portable', '中文 空格'),
    argv: ['whale.exe'],
  }

  it('便携版数据放在实际 exe 旁，而不是解压后的临时目录', () => {
    expect(resolvePortableUserDataPath(portable)).toBe(join(portable.portableExecutableDir, 'data'))
  })

  it('开发版即使继承便携环境变量，也不改变个人数据目录', () => {
    expect(resolvePortableUserDataPath({ ...portable, isPackaged: false })).toBeNull()
  })

  it('安装版没有便携环境变量，保留默认目录', () => {
    expect(
      resolvePortableUserDataPath({ ...portable, portableExecutableDir: undefined }),
    ).toBeNull()
  })

  it('空环境变量不被当作当前目录', () => {
    expect(resolvePortableUserDataPath({ ...portable, portableExecutableDir: '' })).toBeNull()
  })

  it('显式 --user-data-dir=path 优先于便携目录，避免污染真实数据', () => {
    expect(
      resolvePortableUserDataPath({ ...portable, argv: ['whale.exe', '--user-data-dir=test'] }),
    ).toBeNull()
  })

  it('显式 --user-data-dir path 同样保留测试隔离', () => {
    expect(
      resolvePortableUserDataPath({ ...portable, argv: ['whale.exe', '--user-data-dir', 'test'] }),
    ).toBeNull()
  })
})
