/** The S33 office extension: ordered, complete, and independent of message text. */
export const OFFICE_SCENES = [
  ['startup', '签到启动', 'waving'],
  ['requirements', '阅读需求', 'review'],
  ['planning', '制定计划', 'review'],
  ['file-search', '搜索文件', 'review'],
  ['document-read', '阅读文档', 'review'],
  ['code-write', '编写代码', 'running'],
  ['terminal', '运行终端', 'running'],
  ['build', '构建编译', 'running'],
  ['test', '执行测试', 'running'],
  ['debug', '调试排错', 'review'],
  ['code-review', '代码评审', 'review'],
  ['web-search', '网络搜索', 'review'],
  ['browser', '浏览器操作', 'running'],
  ['form-fill', '填写表单', 'running'],
  ['download', '下载资料', 'running'],
  ['data-analysis', '数据分析', 'running'],
  ['spreadsheet', '表格处理', 'running'],
  ['document-write', '文档写作', 'running'],
  ['slides', '幻灯片制作', 'running'],
  ['pdf-read', 'PDF 阅读', 'review'],
  ['image-generate', '图片生成', 'running'],
  ['image-edit', '图片修改', 'running'],
  ['canvas', '画布整理', 'running'],
  ['meeting', '会议协作', 'running'],
  ['upload', '上传同步', 'running'],
  ['waiting', '等待审批/用户', 'waiting'],
  ['queue', '处理消息队列', 'running'],
  ['goal', 'Goal 长任务专注', 'running'],
  ['delivery', '打包交付/成功', 'jumping'],
  ['error', '错误恢复/重试', 'failed'],
] as const
export type OfficeScene = typeof OFFICE_SCENES[number][0]
export type PetScene = OfficeScene | 'idle' | 'running'
export type StandardState = typeof OFFICE_SCENES[number][2] | 'idle' | 'running-left' | 'running-right'
export function isOfficeScene(value: unknown): value is OfficeScene {
  return typeof value === 'string' && OFFICE_SCENES.some(scene => scene[0] === value)
}
export function standardState(scene: PetScene): StandardState {
  return scene === 'running' ? 'running' : OFFICE_SCENES.find(row => row[0] === scene)?.[2] ?? 'idle'
}
