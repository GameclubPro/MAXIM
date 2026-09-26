import type { ManagedEntityFavoriteType } from '@maxim/contracts';
import type { ElementType, SVGProps } from 'react';
import { AppIcon } from './app-icon';

export function SearchGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Search" {...props} />;
}

export function RefreshGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="RefreshDouble" {...props} />;
}

export function StarGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Star" {...props} />;
}

export function XmarkGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Xmark" {...props} />;
}

export function SettingsGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Settings" {...props} />;
}

export function FilterGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="FilterList" {...props} />;
}

export function StatisticsGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="StatsUpSquare" {...props} />;
}

export function PlusCircleGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="PlusCircle" {...props} />;
}

export function WatchGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="ShieldAlert" {...props} />;
}

export function BroadcastGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Megaphone" {...props} />;
}

export function BookmarkGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Bookmark" {...props} />;
}

export function SendGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="SendDiagonal" {...props} />;
}

export function TestGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Flask" {...props} />;
}

export function PartnerGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Community" {...props} />;
}

export function WrenchGlyph(props: SVGProps<SVGSVGElement>) {
  return <AppIcon icon="Wrench" {...props} />;
}

export const HOME_ENTITY_FAVORITE_ICONS = {
  important: StarGlyph,
  watch: WatchGlyph,
  broadcast: BroadcastGlyph,
  test: TestGlyph,
  partner: PartnerGlyph,
  service: WrenchGlyph,
} as const satisfies Record<ManagedEntityFavoriteType, ElementType<SVGProps<SVGSVGElement>>>;
