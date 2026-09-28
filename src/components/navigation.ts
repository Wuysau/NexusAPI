import {
  BookOpen,
  ClipboardCheck,
  CreditCard,
  FileText,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Network,
  Scale,
  Settings2,
  ShieldCheck,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavEntry {
  href: string
  label: string
  icon: LucideIcon
  group?: string
  capability?: string
  keywords: string[]
}

export const NAV: NavEntry[] = [
  {
    href: '/',
    label: '数据概览',
    icon: LayoutDashboard,
    capability: 'usage:read',
    keywords: ['overview', 'dashboard', '概览'],
  },
  {
    href: '/resources',
    label: '资源',
    icon: Layers3,
    group: '资源管理',
    capability: 'credential:read',
    keywords: ['resource', '资源'],
  },
  {
    href: '/routing',
    label: '路由',
    icon: Network,
    group: '资源管理',
    capability: 'project:read',
    keywords: ['route', 'routing', '路由'],
  },
  {
    href: '/channels',
    label: '渠道管理',
    icon: Network,
    group: '资源管理',
    capability: 'credential:read',
    keywords: ['channel', 'provider', '渠道'],
  },
  {
    href: '/connections',
    label: '我的连接',
    icon: Network,
    group: '资源管理',
    capability: 'credential:read',
    keywords: ['connection', 'byok', '连接'],
  },
  { href: '/models', label: '模型广场', icon: Layers3, capability: 'pricing:read', keywords: ['model', '模型'] },
  {
    href: '/pricing',
    label: '价格审批',
    icon: ClipboardCheck,
    capability: 'pricing:read',
    keywords: ['price', 'pricing', '价格'],
  },
  {
    href: '/keys',
    label: 'API 密钥',
    icon: KeyRound,
    group: '工作空间',
    capability: 'apikey:read',
    keywords: ['key', 'api', '密钥'],
  },
  {
    href: '/projects',
    label: '项目',
    icon: Layers3,
    group: '工作空间',
    capability: 'project:read',
    keywords: ['project', '项目'],
  },
  {
    href: '/tasks',
    label: '任务',
    icon: ClipboardCheck,
    capability: 'project:read',
    keywords: ['task', 'codex', '任务', '交接'],
  },
  {
    href: '/logs',
    label: '请求日志',
    icon: FileText,
    capability: 'request:read',
    keywords: ['log', 'request', '日志'],
  },
  {
    href: '/billing',
    label: '用量与计费',
    icon: CreditCard,
    capability: 'billing:read',
    keywords: ['billing', 'usage', '计费'],
  },
  {
    href: '/reconciliation',
    label: '对账工单',
    icon: Scale,
    capability: 'billing:read',
    keywords: ['reconciliation', '对账'],
  },
  {
    href: '/playground',
    label: '在线调试',
    icon: Terminal,
    capability: 'request:read',
    keywords: ['playground', 'debug', '调试'],
  },
  {
    href: '/members',
    label: '成员与角色',
    icon: Users,
    group: '治理',
    capability: 'member:read',
    keywords: ['member', 'role', '成员'],
  },
  { href: '/audit', label: '审计日志', icon: ShieldCheck, capability: 'audit:read', keywords: ['audit', '审计'] },
  { href: '/settings', label: '系统设置', icon: Settings2, capability: 'org:read', keywords: ['setting', '设置'] },
]

export const DOCS_ENTRY: NavEntry = {
  href: '/docs',
  label: '开发文档',
  icon: BookOpen,
  keywords: ['docs', '文档', '帮助'],
}

export function searchNavigation(query: string, can: (capability: string) => boolean): NavEntry[] {
  const normalized = query.trim().toLowerCase()
  return [...NAV, DOCS_ENTRY].filter(
    (entry) =>
      (!entry.capability || can(entry.capability)) &&
      (!normalized ||
        entry.label.toLowerCase().includes(normalized) ||
        entry.keywords.some((word) => word.includes(normalized))),
  )
}
