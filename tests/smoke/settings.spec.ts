/**
 * 设置窗冒烟（契约 2.0；0.4.0 自定义默认提醒）
 *
 * 覆盖：真实托盘入口/单例、自启与广播、设置窗 sender 权限（4 invoke，拒绝其余 27 项）、
 * 「默认提醒时间」预设 5/15/30/60 + 自定义 1–1440 校验/保存/持久化、「HUD 显示范围」下拉、
 * 旧 settings.json 缺 version/新字段启动回退默认且未知字段保留、首次保存写 version=1。
 *
 * 本机 DSH 沙箱内 Electron 无法启动（spawn EPERM），由宿主执行 `pnpm smoke`。
 */
import { _electron as electron, test as baseTest } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Menu } from 'electron'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { PetApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

function isolatedEnv(profile: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env['APPDATA'] = profile
  env['LOCALAPPDATA'] = profile
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_RENDERER_URL']
  delete env['WHALE_PET_HIT_TRACE']
  return env
}

// Capture the actual menu produced by the app, without adding a product IPC or
// reproducing the callback's implementation. Electron MenuItem.click supplies
// native checkbox toggling before calling the application callback.
async function captureTray(app: ElectronApplication, pet: Page): Promise<void> {
  await app.evaluate(({ Tray }) => {
    const state = globalThis as unknown as { smokeTrayMenu: Menu | null }
    state.smokeTrayMenu = null
    const original = Tray.prototype.setContextMenu
    Tray.prototype.setContextMenu = function (menu) {
      state.smokeTrayMenu = menu
      return original.call(this, menu)
    }
  })
  await pet.evaluate(() => (globalThis as unknown as { pet: PetApi }).pet.updateSettings({}))
}

async function clickTray(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate((_electron, label) => {
    const state = globalThis as unknown as { smokeTrayMenu: Menu | null }
    const item = state.smokeTrayMenu?.items.find((entry) => entry.label.includes(label))
    if (item === undefined) throw new Error(`托盘入口缺失: ${label}`)
    item.click()
  }, label)
}

async function openSettings(app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent('window')
  await clickTray(app, '设置')
  const page = await opened
  await expect(page.getByRole('heading', { name: '鲸鱼娘 · 设置' })).toBeVisible()
  await expect(page.getByRole('checkbox').first()).toBeDisabled()
  return page
}

test('设置窗真实入口、单例和关闭重开保留设置', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const settings = await openSettings(petApp)
  await clickTray(petApp, '设置')
  expect(petApp.windows().filter((page) => page.url().includes('settings.html'))).toEqual([
    settings,
  ])

  const windowState = await petApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes('settings.html'),
    )
    return win === undefined
      ? null
      : { focusable: win.isFocusable(), alwaysOnTop: win.isAlwaysOnTop() }
  })
  expect(windowState).toEqual({ focusable: true, alwaysOnTop: false })

  const muted = settings.getByRole('checkbox').nth(1)
  await expect(muted).toBeDisabled()
  await petPage.evaluate(() =>
    (globalThis as unknown as { pet: PetApi }).pet.updateSettings({ muted: true }),
  )
  await expect(muted).toBeChecked()
  await expect(muted).toBeDisabled()
  const closed = settings.waitForEvent('close')
  try {
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
  } catch (error) {
    if (!settings.isClosed()) throw error
  }
  await closed
  expect(petApp.windows()).toEqual([petPage])
  const reopened = await openSettings(petApp)
  expect(reopened).not.toBe(settings)
  await expect(reopened.getByRole('checkbox').nth(1)).toBeChecked()
})

test('开发版自启入口禁用，设置广播仍同步到打开的设置页与托盘', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const settings = await openSettings(petApp)
  const autostart = settings.getByRole('checkbox').first()
  await expect(autostart).toBeDisabled()
  expect(
    await petApp.evaluate(() => {
      const state = globalThis as unknown as { smokeTrayMenu: Menu | null }
      return state.smokeTrayMenu?.items.find((item) => item.label.includes('开机自启'))?.enabled
    }),
  ).toBe(false)

  async function trayValue(): Promise<boolean | undefined> {
    return petApp.evaluate(() => {
      const state = globalThis as unknown as { smokeTrayMenu: Menu | null }
      return state.smokeTrayMenu?.items.find((item) => item.label.includes('开机自启'))?.checked
    })
  }

  for (const expected of [true, false]) {
    await petPage.evaluate(
      (autostart) => (globalThis as unknown as { pet: PetApi }).pet.updateSettings({ autostart }),
      expected,
    )
    await expect(autostart).toBeChecked({ checked: expected })
    await expect.poll(trayValue).toBe(expected)
    const stored = await petPage.evaluate(() =>
      (globalThis as unknown as { pet: PetApi }).pet.getSettings(),
    )
    expect(stored.autostart).toBe(expected)
  }
})

test('设置角色允许4项invoke、拒绝其余27项且不影响宠物窗', async ({ petApp, petPage }) => {
  await captureTray(petApp, petPage)
  const settings = await openSettings(petApp)
  const allowed = await settings.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const bootstrap = await pet.bootstrap()
    await pet.updateSettings({ muted: true })
    const stored = await pet.getSettings()
    await pet.resetPosition()
    return { version: bootstrap.ipcVersion, stored }
  })
  expect(allowed).toEqual({
    version: '2.0.0',
    stored: {
      autostart: false,
      muted: true,
      reminderLeadMin: 15,
      customReminderLeadMin: null,
      hudScope: 'urgent',
    },
  })

  const rejected = await settings.evaluate(async () => {
    const pet = (globalThis as unknown as { pet: PetApi }).pet
    const calls = [
      () => pet.setClickThrough(true),
      () => pet.getClickThrough(),
      () => pet.moveBy(10, 10),
      () => pet.setVisible(false),
      () => pet.getPlacement(),
      () => pet.showContextMenu('pet'),
      () => pet.setBubbleVisible(false),
      () => pet.setBubbleRegion(null),
      () => pet.listTasks({ scope: 'all' }),
      () => pet.createTask({ title: '不应创建' }),
      () => pet.updateTask({ id: 'not-allowed', patch: { title: '不应修改' } }),
      () => pet.toggleTask({ id: 'not-allowed' }),
      () => pet.deleteTask('not-allowed'),
      () => pet.restoreTask('not-allowed'),
      () => pet.setTaskArchived({ id: 'not-allowed', archived: true }),
      () => pet.getTaskStats(),
      () => pet.openTasks(),
      // 0.4：设置窗也不允许项目与独立打卡通道
      () => pet.listProjects(),
      () => pet.createProject({ name: '不应创建' }),
      () => pet.updateProject({ id: 'not-allowed', patch: { name: '不应修改' } }),
      () => pet.deleteProject('not-allowed'),
      () => pet.listHabits(),
      () =>
        pet.createHabit({
          name: '不应创建',
          schedule: { frequency: 'daily', deadlineWeekday: null },
        }),
      () => pet.updateHabit({ id: 'not-allowed', patch: { name: '不应修改' } }),
      () => pet.deleteHabit('not-allowed'),
      () => pet.checkinHabit({ habitId: 'not-allowed', cycleKey: 'not-allowed' }),
      () => pet.listHabitHistory({ habitId: 'not-allowed' }),
    ]
    const outcomes: boolean[] = []
    for (const call of calls) {
      try {
        await call()
        outcomes.push(false)
      } catch (error) {
        outcomes.push(String(error).includes('IPC_SENDER_REJECTED'))
      }
    }
    return outcomes
  })
  expect(rejected).toEqual(Array<boolean>(27).fill(true))
  await expect(petPage.locator('.pet-sprite')).toBeVisible()
})

test('默认提醒时间：预设 5/15/30/60 + 自定义 1–1440 校验/保存/持久化/重开保留', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const settings = await openSettings(petApp)
  const lead = settings.getByRole('combobox', { name: '默认提醒时间' })
  const profile = await petApp.evaluate(({ app }) => app.getPath('userData'))

  // 默认 15；预设 4 档 + 自定义
  await expect(lead).toHaveValue('15')
  await expect(lead.locator('option')).toHaveText([
    '5 分钟',
    '15 分钟',
    '30 分钟',
    '60 分钟',
    '自定义',
  ])
  await expect(settings.getByText(/1–1440 整数分钟/)).toBeVisible()

  const readSettings = async () =>
    petPage.evaluate(async () => {
      const pet = (globalThis as unknown as { pet: PetApi }).pet
      return pet.getSettings()
    })
  const readDisk = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      return {}
    }
  }

  // 预设：同一次 patch 写旧字段 + custom=null
  await lead.selectOption('30')
  await expect.poll(async () => (await readSettings()).reminderLeadMin).toBe(30)
  expect((await readSettings()).customReminderLeadMin).toBeNull()
  await expect.poll(async () => (await readDisk())['reminderLeadMin']).toBe(30)
  expect((await readDisk())['customReminderLeadMin']).toBeNull()

  // 自定义：显示输入框 + 保存按钮，1–1440 整数
  await lead.selectOption('custom')
  const custom = settings.getByLabel('自定义默认提醒时间（分钟）')
  await expect(custom).toBeVisible()
  await custom.fill('45')
  await settings.getByRole('button', { name: '保存自定义提醒时间' }).click()
  await expect.poll(async () => (await readSettings()).customReminderLeadMin).toBe(45)
  // 旧预设字段不被暗改
  expect((await readSettings()).reminderLeadMin).toBe(30)
  await expect.poll(async () => (await readDisk())['customReminderLeadMin']).toBe(45)

  // 非法值：行内错误且不写盘
  for (const invalid of ['0', '1441', '3.5']) {
    await custom.fill(invalid)
    await settings.getByRole('button', { name: '保存自定义提醒时间' }).click()
    await expect(settings.getByRole('alert')).toHaveText('请输入 1–1440 的整数分钟')
    expect((await readSettings()).customReminderLeadMin).toBe(45)
    expect((await readDisk())['customReminderLeadMin']).toBe(45)
  }
  // 合法边界：1 与 1440
  for (const valid of ['1', '1440']) {
    await custom.fill(valid)
    await settings.getByRole('button', { name: '保存自定义提醒时间' }).click()
    await expect.poll(async () => String((await readSettings()).customReminderLeadMin)).toBe(valid)
  }

  // 切回预设：custom 归 null
  await lead.selectOption('15')
  await expect.poll(async () => (await readSettings()).reminderLeadMin).toBe(15)
  expect((await readSettings()).customReminderLeadMin).toBeNull()

  // 关闭重开：显示实际有效值（预设 15）
  const closed = settings.waitForEvent('close')
  try {
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
  } catch (error) {
    if (!settings.isClosed()) throw error
  }
  await closed
  const reopened = await openSettings(petApp)
  await expect(reopened.getByRole('combobox', { name: '默认提醒时间' })).toHaveValue('15')
})

test('HUD 显示范围下拉：默认仅紧急、切「紧急 + 今日到期」即时保存、写回文件并重开保留', async ({
  petApp,
  petPage,
}) => {
  await captureTray(petApp, petPage)
  const settings = await openSettings(petApp)
  const scope = settings.getByRole('combobox', { name: 'HUD 显示范围' })

  // 契约 1.9：默认仅紧急；两个选项
  await expect(scope).toHaveValue('urgent')
  await expect(scope.locator('option')).toHaveText(['仅紧急（默认）', '紧急 + 今日到期'])
  await expect(settings.getByText('桌宠上常驻的紧急任务卡片范围；默认仅紧急')).toBeVisible()

  await scope.selectOption('urgent-due')
  await expect(scope).toHaveValue('urgent-due')
  await expect
    .poll(async () =>
      petPage.evaluate(async () => {
        const pet = (globalThis as unknown as { pet: PetApi }).pet
        return (await pet.getSettings()).hudScope
      }),
    )
    .toBe('urgent-due')

  // 防抖落盘：settings.json 写回 hudScope（旧字段保留）
  const profile = await petApp.evaluate(({ app }) => app.getPath('userData'))
  await expect
    .poll(async () => {
      try {
        const disk = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')) as Record<
          string,
          unknown
        >
        return disk['hudScope']
      } catch {
        return null
      }
    })
    .toBe('urgent-due')

  // 关闭重开设置窗：同一进程内读回最后选择
  const closed = settings.waitForEvent('close')
  try {
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
  } catch (error) {
    if (!settings.isClosed()) throw error
  }
  await closed
  const reopened = await openSettings(petApp)
  await expect(reopened.getByRole('combobox', { name: 'HUD 显示范围' })).toHaveValue('urgent-due')
})

baseTest('旧 settings.json 缺新字段启动回退默认，未知字段写回保留', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'whale-pet-settings-compat-'))
  const settingsPath = join(profile, 'settings.json')
  // 0.2.0 形状：缺 version / reminderLeadMin / customReminderLeadMin / hudScope，带一个未知字段
  await writeFile(
    settingsPath,
    JSON.stringify({ autostart: false, muted: true, legacyField: 'keep-me' }),
    'utf8',
  )
  let application: ElectronApplication | undefined
  try {
    application = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${profile}`],
      env: isolatedEnv(profile),
    })
    const pet = await application.firstWindow()
    await expect(pet.locator('.pet-sprite')).toBeVisible()

    const bootstrap = await pet.evaluate(async () =>
      (globalThis as unknown as { pet: PetApi }).pet.bootstrap(),
    )
    // 契约 2.0：缺 version 视为 v1；缺字段回退默认（15 / null / urgent），不因缺字段失败
    expect(bootstrap.settings).toEqual({
      autostart: false,
      muted: true,
      reminderLeadMin: 15,
      customReminderLeadMin: null,
      hudScope: 'urgent',
    })

    // 改为 30：防抖落盘后旧未知字段必须保留，且不是坏文件（无 .bad 备份）
    await pet.evaluate(() =>
      (globalThis as unknown as { pet: PetApi }).pet.updateSettings({ reminderLeadMin: 30 }),
    )
    await expect
      .poll(async () => {
        try {
          const disk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
          return disk['reminderLeadMin']
        } catch {
          return null
        }
      })
      .toBe(30)

    const disk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    expect(disk['version']).toBe(1)
    expect(disk['legacyField']).toBe('keep-me')
    expect(disk['muted']).toBe(true)
    // 旧文件缺新字段：默认值随下一次写盘落盘（仍为合法设置文件，不产生 .bad 备份）
    expect(disk['hudScope']).toBe('urgent')
    expect(disk['customReminderLeadMin']).toBeNull()
    const entries = await readdir(profile)
    expect(entries.filter((name) => name.startsWith('settings.json.bad'))).toEqual([])
  } finally {
    try {
      if (application !== undefined) await application.close()
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})
