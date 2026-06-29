import type { ManagedEntityFavoriteType } from '@maxim/contracts';
import type { ElementType, SVGProps } from 'react';

export function SearchGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="10.8" cy="10.8" r="6.2" />
      <path d="M15.4 15.4 20 20" />
    </svg>
  );
}

export function RefreshGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M20 7.5v4h-4" />
      <path d="M4 16.5v-4h4" />
      <path d="M18.3 10.2A6.7 6.7 0 0 0 6.6 7.4L4 12.5" />
      <path d="M5.7 13.8a6.7 6.7 0 0 0 11.7 2.8L20 11.5" />
    </svg>
  );
}

export function StarGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" {...props}>
      <path
        d="m12 3.6 2.5 5 5.5.8-4 3.9.9 5.5L12 16.2l-4.9 2.6.9-5.5-4-3.9 5.5-.8L12 3.6Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function XmarkGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      {...props}
    >
      <path d="M6.5 6.5 17.5 17.5" />
      <path d="M17.5 6.5 6.5 17.5" />
    </svg>
  );
}

export function SettingsGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4.5 7.5h15" />
      <path d="M4.5 16.5h15" />
      <path d="M8.2 4.8v5.4" />
      <path d="M15.8 13.8v5.4" />
      <path d="M6.6 7.5h3.2" />
      <path d="M14.2 16.5h3.2" />
    </svg>
  );
}

export function WatchGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M12 3.5l7 2.7v5.1c0 4.2-2.7 7.4-7 9.2-4.3-1.8-7-5-7-9.2V6.2l7-2.7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 7.8v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 16.2h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function BroadcastGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M5 13.5h3.4l7.6 4.2V6.3l-7.6 4.2H5v3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M19 9a4.8 4.8 0 010 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M8 13.5l1.2 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BookmarkGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M7 4.5h10v15l-5-3-5 3v-15Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SendGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M4.5 11.8 19 5l-6.8 14.5-1.9-6.1-5.8-1.6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10.3 13.4 19 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function TestGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M9 3.8h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M10 4v5.2l-4.1 7.2A2.6 2.6 0 008.2 20h7.6a2.6 2.6 0 002.3-3.6L14 9.2V4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M8 16h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PartnerGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M7.5 11.5a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4ZM16.5 11.5a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M3.8 19.2c.7-2.7 2.4-4.2 4.8-4.2 1.4 0 2.5.5 3.4 1.4.9-.9 2-1.4 3.4-1.4 2.4 0 4.1 1.5 4.8 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WrenchGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M14.6 5.2a4.8 4.8 0 005.1 5.1l-8.9 8.9a3 3 0 01-4.2-4.2l8-9.8Z" />
      <path d="M7.8 16.2l-1.2 1.2" />
    </svg>
  );
}

export const HOME_ENTITY_FAVORITE_ICONS = {
  important: StarGlyph,
  watch: WatchGlyph,
  broadcast: BroadcastGlyph,
  test: TestGlyph,
  partner: PartnerGlyph,
  service: WrenchGlyph,
} as const satisfies Record<ManagedEntityFavoriteType, ElementType<SVGProps<SVGSVGElement>>>;
