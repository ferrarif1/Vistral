import type { CSSProperties, ReactNode } from 'react';

export interface PixelRoomAction {
  label: ReactNode;
  to: string;
}

export interface PixelRoomContext {
  scene: string;
  asset: string;
  label: ReactNode;
  description: ReactNode;
  companion: string;
  actions?: readonly PixelRoomAction[];
}

export const pixelSceneByRoute = [
  {
    test: (pathname: string) => pathname === '/workspace/pixel-lab',
    scene: 'home',
    asset: '/assets/vistral-workshop/overview.png',
    label: '训练之家',
    description: '七个核心房间把数据、标注、配方、训练、验证、发布和部署串成闭环。',
    companion: '/assets/vistral-workshop/robot.png',
    actions: [
      { label: '返回控制台', to: '/workspace/console' },
      { label: '开始训练', to: '/training/jobs/new' }
    ]
  },
  {
    test: (pathname: string) =>
      pathname.startsWith('/workspace') || pathname.startsWith('/vision') || pathname.startsWith('/auth'),
    scene: 'command',
    asset: '/assets/vistral-workshop/command.svg',
    label: '指挥室',
    description: '对话、任务理解和下一步建议集中在这里。',
    companion: '/assets/vistral-workshop/scientist.png',
    actions: [
      { label: '打开训练之家', to: '/workspace/pixel-lab' },
      { label: '查看任务 inbox', to: '/vision/tasks' }
    ]
  },
  {
    test: (pathname: string) => pathname.includes('/annotate'),
    scene: 'cleaning',
    asset: '/assets/vistral-workshop/cleaning.svg',
    label: '清洗标注室',
    description: '清洗样本、补齐标注、审核问题数据。',
    companion: '/assets/vistral-workshop/scientist.png',
    actions: [
      { label: '数据集', to: '/datasets' },
      { label: '训练之家', to: '/workspace/pixel-lab' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/datasets') || pathname.includes('/annotate'),
    scene: 'dataset',
    asset: '/assets/vistral-workshop/dataset.png',
    label: '数据集仓库',
    description: '准备样本、标注、审核和版本快照。',
    companion: '/assets/vistral-workshop/scientist.png',
    actions: [
      { label: '数据集', to: '/datasets' },
      { label: '训练之家', to: '/workspace/pixel-lab' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/training/jobs/new'),
    scene: 'recipe',
    asset: '/assets/vistral-workshop/recipe.svg',
    label: '模型配方室',
    description: '选择任务类型、框架、基座模型和训练参数。',
    companion: '/assets/vistral-workshop/wizard.png',
    actions: [
      { label: '训练队列', to: '/training/jobs' },
      { label: 'Runtime', to: '/settings/runtime' }
    ]
  },
  {
    test: (pathname: string) =>
      pathname.startsWith('/training') || pathname === '/training-workshop' || pathname.startsWith('/workflow'),
    scene: 'training',
    asset: '/assets/vistral-workshop/training.png',
    label: '训练室',
    description: '把数据快照、配方、worker 和训练证据连起来。',
    companion: '/assets/vistral-workshop/robot.png',
    actions: [
      { label: '训练队列', to: '/training/jobs' },
      { label: '新建训练', to: '/training/jobs/new' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/inference'),
    scene: 'exam',
    asset: '/assets/vistral-workshop/exam.png',
    label: '考试室',
    description: '选择模型版本和验证集，生成考试结果与反馈样本。',
    companion: '/assets/vistral-workshop/wizard.png',
    actions: [
      { label: '开始验证', to: '/inference/validate' },
      { label: '反馈回流', to: '/datasets' }
    ]
  },
  {
    test: (pathname: string) =>
      pathname.startsWith('/admin/audit') || pathname.startsWith('/admin/verification-reports'),
    scene: 'feedback',
    asset: '/assets/vistral-workshop/feedback.svg',
    label: '修复回流区',
    description: '失败任务、badcase、审计记录和回流建议在这里处理。',
    companion: '/assets/vistral-workshop/robot.png',
    actions: [
      { label: '审计', to: '/admin/audit' },
      { label: '验证报告', to: '/admin/verification-reports' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/models/explore') || pathname.startsWith('/models/my-models') || pathname.startsWith('/models/create'),
    scene: 'models',
    asset: '/assets/vistral-workshop/models.svg',
    label: '模型角色室',
    description: '浏览模型角色、创建模型、查看个人模型库存。',
    companion: '/assets/vistral-workshop/scientist.png',
    actions: [
      { label: '模型版本', to: '/models/versions' },
      { label: '创建模型', to: '/models/create' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/models') || pathname.startsWith('/admin'),
    scene: 'publish',
    asset: '/assets/vistral-workshop/publish.svg',
    label: '发布室',
    description: '模型版本、审批、毕业墙和治理记录在这里完成闭环。',
    companion: '/assets/vistral-workshop/wizard.png',
    actions: [
      { label: '模型版本', to: '/models/versions' },
      { label: '审批', to: '/admin/models/pending' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/settings/runtime') || pathname.startsWith('/settings/workers'),
    scene: 'runtime',
    asset: '/assets/vistral-workshop/runtime.svg',
    label: '运行室',
    description: '运行时、worker、密钥和服务健康状态集中监控。',
    companion: '/assets/vistral-workshop/robot.png',
    actions: [
      { label: '运行时', to: '/settings/runtime' },
      { label: 'Worker', to: '/settings/workers' }
    ]
  },
  {
    test: (pathname: string) => pathname.startsWith('/settings'),
    scene: 'settings',
    asset: '/assets/vistral-workshop/settings.svg',
    label: '系统设置室',
    description: '账号、语言、LLM 和系统参数集中配置。',
    companion: '/assets/vistral-workshop/robot.png',
    actions: [
      { label: '运行时', to: '/settings/runtime' },
      { label: 'Worker', to: '/settings/workers' }
    ]
  }
] as const;

export const defaultPixelScene: PixelRoomContext = {
  scene: 'home',
  asset: '/assets/vistral-workshop/command.svg',
  label: '模型训练之家',
  description: '当前页面已接入统一项目上下文。',
  companion: '/assets/vistral-workshop/robot.png'
};

export function resolvePixelRoomContext(pathname: string): PixelRoomContext {
  return pixelSceneByRoute.find((entry) => entry.test(pathname)) ?? defaultPixelScene;
}

export function createPixelRoomStyle(context: PixelRoomContext, style?: CSSProperties) {
  return {
    ...style,
    '--workspace-pixel-scene-image': `url("${context.asset}")`,
    '--workspace-pixel-companion-image': `url("${context.companion}")`
  } as CSSProperties;
}
