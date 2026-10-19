// Icons: Lucide through lucide-react (an absolute 1.5px stroke, named
// sizes only), plus stam's own harness marks.
import type { LucideIcon } from 'lucide-react'
import {
  AlarmClock, AlarmClockOff, Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bell, BellOff, Bot, Braces, ChartColumn, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, Clock, Columns2, CornerDownLeft, CornerLeftUp, CircleAlert,
  Cpu, Crown, Download, Ellipsis, ExternalLink, Eye, FileText, FlaskConical, Folder, Gauge, GitBranch, Globe, Grid3x3, GitPullRequest, GripVertical, Inbox, Info, Kanban, Keyboard, KeyboardOff, Layers, LayoutList, Link, ListChecks, Lock, LogOut, Mail, Menu, Mic, MessageSquare, Minimize2, Monitor, Moon, Network, PanelBottomOpen,

  PanelLeftOpen, Paperclip, Pause, Pencil, Play, Plug, Minus, Plus, Power, Radio, Reply, RotateCcw, Rows2, Scale, Scan, Search, Send, Server, Settings, Shield, ShieldAlert, SlidersHorizontal, Smartphone, Square,
  SquareCheck, Sun, Tag, Terminal, Trash2, Upload, User, Users, Wrench, X, Zap,
} from 'lucide-react'
import { ICONS } from './icons'

const LUCIDE: Record<string, LucideIcon> = {
  'alarm-clock': AlarmClock, 'alarm-clock-off': AlarmClockOff, archive: Archive, 'archive-restore': ArchiveRestore, 'arrow-down': ArrowDown, 'arrow-left': ArrowLeft, 'arrow-right': ArrowRight, 'arrow-up': ArrowUp, bell: Bell, 'bell-off': BellOff, bot: Bot,
  braces: Braces, 'chart-column': ChartColumn, check: Check, 'chevron-down': ChevronDown, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, 'chevron-up': ChevronUp, 'circle-help': CircleHelp, clock: Clock, 'circle-alert': CircleAlert,
  'columns-2': Columns2, 'corner-down-left': CornerDownLeft, 'corner-left-up': CornerLeftUp, cpu: Cpu, crown: Crown, download: Download, ellipsis: Ellipsis, 'external-link': ExternalLink, eye: Eye, 'file-text': FileText, 'flask-conical': FlaskConical, folder: Folder, gauge: Gauge, 'git-branch': GitBranch, globe: Globe, 'grid-3x3': Grid3x3, 'git-pull-request': GitPullRequest, 'grip-vertical': GripVertical, inbox: Inbox,
  info: Info, kanban: Kanban, keyboard: Keyboard, 'keyboard-off': KeyboardOff, layers: Layers, 'layout-list': LayoutList, link: Link, 'list-checks': ListChecks, lock: Lock, 'log-out': LogOut, mail: Mail, menu: Menu, mic: Mic, 'message-square': MessageSquare, 'minimize-2': Minimize2,

  monitor: Monitor, moon: Moon, network: Network, 'panel-bottom-open': PanelBottomOpen, 'panel-left-open': PanelLeftOpen,
  paperclip: Paperclip, pause: Pause, pencil: Pencil, play: Play, minus: Minus, plug: Plug, plus: Plus, power: Power, radio: Radio, reply: Reply, 'rotate-ccw': RotateCcw,
  'rows-2': Rows2, scale: Scale, scan: Scan, search: Search, send: Send, server: Server, settings: Settings, shield: Shield, 'shield-alert': ShieldAlert, 'sliders-horizontal': SlidersHorizontal, smartphone: Smartphone, square: Square,
  'square-check': SquareCheck, sun: Sun, tag: Tag, terminal: Terminal, 'trash-2': Trash2, upload: Upload, user: User, users: Users, wrench: Wrench, x: X, zap: Zap,
}
export type IconName = keyof typeof LUCIDE | 'claude' | 'codex' | 'opencode' | 'stam'
// Every name Icon draws, for the stories page.
export const ICON_NAMES: string[] = [...Object.keys(LUCIDE), 'claude', 'codex', 'opencode', 'stam']

const SIZES = { xs: 14, sm: 16 } as const
const STROKE = 1.5

export function Icon({ name, size = 'sm' }: { name: IconName | string; size?: keyof typeof SIZES }) {
  const cls = size === 'xs' ? 'i xs' : 'i'
  const Glyph = LUCIDE[name]
  if (Glyph) return <Glyph className={cls} size={SIZES[size]} strokeWidth={STROKE} absoluteStrokeWidth aria-hidden="true" />
  // The harness marks are drawn on Lucide's grid, in the same stroke.
  return <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.bot }} />
}
