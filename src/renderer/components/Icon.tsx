import {
  ArrowLeft,
  ArrowRight,
  ChartColumn,
  Download,
  Landmark,
  Link2,
  Package,
  QrCode,
  Smartphone,
  Trash2,
  CalendarClock,
  Info,
  Globe,
  LogOut,
  Megaphone,
  Building2,
  Check,
  Clock,
  ExternalLink,
  FileText,
  History,
  House,
  Inbox,
  KeyRound,
  Mail,
  Monitor,
  Moon,
  Pause,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  Sun,
  TriangleAlert,
  User,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const MAP: Record<string, LucideIcon> = {
  home: House,
  history: History,
  settings: Settings,
  refresh: RefreshCw,
  mail: Mail,
  file: FileText,
  check: Check,
  x: X,
  alert: TriangleAlert,
  clock: Clock,
  user: User,
  shield: Shield,
  zap: Zap,
  building: Building2,
  arrow: ArrowRight,
  back: ArrowLeft,
  open: ExternalLink,
  send: Send,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  key: KeyRound,
  sparkles: Inbox,
  search: Search,
  pause: Pause,
  inbox: Inbox,
  chart: ChartColumn,
  download: Download,
  tax: Landmark,
  link: Link2,
  package: Package,
  qr: QrCode,
  phone: Smartphone,
  trash: Trash2,
  calendar: CalendarClock,
  info: Info,
  globe: Globe,
  logout: LogOut,
  ads: Megaphone,
};

/** Glyph WhatsApp păstrat ca SVG unic — nu există în Lucide. */
function WhatsAppGlyph({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.5 3.5A11 11 0 0 0 3.2 17.3L2 22l4.8-1.2A11 11 0 1 0 20.5 3.5z" />
      <path d="M8.5 7.5c.3-.6.6-.6 1-.6h.6c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .6l-.4.6c-.2.2-.3.4-.1.7a7.6 7.6 0 0 0 3.5 3c.3.1.5.1.7-.1l.7-.8c.2-.2.4-.2.6-.1l2 .9c.3.1.4.3.4.5 0 .7-.3 1.4-1 1.8-.6.4-1.6.5-3-.1a12 12 0 0 1-5.4-4.8c-.9-1.5-.7-2.8.1-4z" />
    </svg>
  );
}

export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  if (name === 'whatsapp') return <WhatsAppGlyph size={size} className={className} />;
  const C = MAP[name] ?? FileText;
  return <C size={size} className={className} strokeWidth={1.5} aria-hidden />;
}
