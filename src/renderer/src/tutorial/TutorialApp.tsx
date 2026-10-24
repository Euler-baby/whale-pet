/**
 * 简易使用教程（0.4.2 同步；静态页面）
 *
 * - 只读静态内容：不调用 window.pet / IPC / 文件，不写死任何个人数据
 * - 五组内容：桌宠操作、清单与项目、搁置与完成、独立打卡、提醒与恢复
 * - section id 统一用 `tutorial-*`，避免 `id="pet"` 被浏览器映射为 `window.pet` 干扰 preload API
 * - 原生标题栏即可关闭；另提供「关闭教程」按钮与 Esc 快捷键（纯浏览器 API）
 */
import { useEffect } from 'react'

interface GuideSection {
  id: string
  title: string
  items: { label: string; text: string }[]
}

const SECTIONS: readonly GuideSection[] = [
  {
    id: 'tutorial-pet',
    title: '桌宠操作',
    items: [
      {
        label: '左键点击',
        text: '鲸鱼娘会开心回应约 3 秒；没有 HUD/提醒卡时同时说一句短台词。',
      },
      {
        label: '按住不动',
        text: '按住左键约 0.45 秒且没有拖动，会触发“摸头”；随后的普通点击会被抑制，不会误触。',
      },
      {
        label: '拖拽',
        text: '按住并移动即可拖动桌宠，可一直拖到屏幕边缘；松手后会记住位置，且窗口至少完整可见。',
      },
      {
        label: '右键菜单',
        text: '隐藏鲸鱼娘、重置窗口位置、打开设置、打开任务清单、打开使用教程、退出。',
      },
      {
        label: '托盘',
        text: '通过任务栏托盘图标显示/隐藏桌宠，也可打开设置、任务清单或退出。',
      },
    ],
  },
  {
    id: 'tutorial-list',
    title: '清单与项目',
    items: [
      {
        label: '两个页面',
        text: '任务清单顶部有「待办 / 打卡」；待办默认是「今日 + 生活」。',
      },
      {
        label: '单一列表',
        text: '当前范围/分类下所有未搁置任务都在同一列表（包含已完成）；已完成显示删除线，再次勾选即可恢复，没有单独的“活动/已完成/搁置”视图。',
      },
      {
        label: '时间与分类',
        text: '时间范围「今日 / 全部」独立；分类有「学习 / 生活 / 运动 / 项目」，再次点击已选分类可取消，看到全部分类混排，项目任务会带项目名标签。',
      },
      {
        label: '摘要与新建',
        text: '摘要显示「今日完成 x/y」「当前范围内 N 项」；窗口右下角「+」打开底部新建面板（归属/重要性/到期/提醒），提交后可继续添加，Esc、关闭按钮或点外部可收起。',
      },
      {
        label: '项目与搁置入口',
        text: '选中「项目」进入项目列表/详情，新建和编辑项目都用弹窗，只有空项目可以删除；摘要右侧「搁置 N」打开独立的搁置任务清单。项目任务不计入生活/运动/学习的分类计数。',
      },
    ],
  },
  {
    id: 'tutorial-archive',
    title: '搁置与完成',
    items: [
      {
        label: '没有状态视图',
        text: '不再有活动/已完成/搁置三个视图；普通列表只显示未搁置任务。',
      },
      {
        label: '完成',
        text: '勾选即完成，任务仍保留在列表并显示删除线；再次勾选可恢复为未完成。完成记录长期保留，只有手动删除才会移除。',
      },
      {
        label: '搁置',
        text: '只有未完成任务可以搁置；搁置后从普通列表隐藏，也不会进入桌宠 HUD 或触发提醒。',
      },
      {
        label: '搁置任务清单',
        text: '摘要右侧「搁置 N」进入独立清单，所有搁置任务集中在这里；可点「恢复」或「删除」，点「返回待办」回到普通列表。',
      },
      {
        label: '删除撤销',
        text: '删除任务后 30 秒内可在顶部点「撤销」恢复（仅当前运行进程内有效）。',
      },
    ],
  },
  {
    id: 'tutorial-habits',
    title: '独立打卡',
    items: [
      {
        label: '独立实体',
        text: '打卡项目与任务、项目、HUD、提醒都相互独立，不需要先建待办，也不影响任务完成统计。',
      },
      {
        label: '频率',
        text: '每个打卡项目选择每天或每周一次；本地时间 04:00 换周期，周截止为所选星期当天 04:00。',
      },
      {
        label: '收起与展开',
        text: '卡片默认收起，只显示名称、频率、本周期是否已打卡和「本期打卡」；点「展开」可看本期起止、备注、打卡时间，以及编辑/历史/删除。',
      },
      {
        label: '本期与规则',
        text: '每个周期最多打卡一次；修改频率或截止日从下一周期生效，当前周期边界不变；历史只读。',
      },
      {
        label: '没有补卡与 streak',
        text: '错过的周期不会补记，也不统计连续天数；首次成功打卡时桌宠会庆祝（减少动态效果时只省略动画，记录仍保存）。',
      },
    ],
  },
  {
    id: 'tutorial-reminder',
    title: '提醒与恢复',
    items: [
      {
        label: '默认提醒时间',
        text: '在设置中选择预设或自定义 1–1440 分钟；单任务可选择“跟随默认”或自定义覆盖。',
      },
      {
        label: '提醒卡',
        text: '普通任务到期前会显示醒目的提醒卡，约 12 秒后自动消失；可点「关闭」或「打开任务清单」。目前没有音效。',
      },
      {
        label: '紧急 HUD',
        text: '紧急任务常驻桌宠 HUD；到期时只更新 HUD，不额外弹普通气泡。',
      },
      {
        label: '免打扰与隐藏',
        text: '23:00–07:00 普通提醒静默（不弹、不排队）；桌宠隐藏时跳过提醒，显示后按当前条件补发；应用关闭时不承诺系统通知。',
      },
      {
        label: '托盘与动态',
        text: '从托盘可恢复/隐藏桌宠、重置窗口位置；开启“减少动态效果”时只减少动画，数据与打卡结果不受影响。',
      },
    ],
  },
]

export default function TutorialApp() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <main className="tutorial">
      <header className="tutorial__header">
        <h1 className="tutorial__title">使用教程</h1>
        <p className="tutorial__subtitle">
          鲸鱼娘 · 简易上手
          <span className="tutorial__meta">5 组要点，约 2 分钟读完</span>
        </p>
      </header>

      <nav className="tutorial__nav" aria-label="教程目录">
        {SECTIONS.map((section, index) => (
          <a key={section.id} className="tutorial__nav-link" href={`#${section.id}`}>
            {index + 1}. {section.title}
          </a>
        ))}
      </nav>

      <div className="tutorial__sections">
        {SECTIONS.map((section, index) => (
          <section key={section.id} id={section.id} className="tutorial-card">
            <h2 className="tutorial-card__title">
              <span className="tutorial-card__index" aria-hidden="true">
                {index + 1}
              </span>
              {section.title}
            </h2>
            <ul className="tutorial-card__list">
              {section.items.map((item) => (
                <li key={item.label} className="tutorial-card__item">
                  <span className="tutorial-card__label">{item.label}</span>
                  <span className="tutorial-card__text">{item.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="tutorial__footer">
        <p className="tutorial__footer-text">
          所有数据都保存在本机；关闭教程可点标题栏 × 或按 Esc。
        </p>
        <button type="button" className="tutorial__close" onClick={() => window.close()}>
          关闭教程
        </button>
      </footer>
    </main>
  )
}
