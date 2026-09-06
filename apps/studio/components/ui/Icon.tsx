import React from "react";

/**
 * ONE ICON STYLE FOR THE WHOLE PRODUCT: 24-unit grid, 1.75 stroke, round joins,
 * inherits `currentColor`. Hand-written so nothing is downloaded and every
 * glyph shares the same weight. Presentation only — icons never replace text.
 */
export type IconName =
  | "questions" | "settings" | "flow" | "logic" | "variables" | "calc" | "quotas" | "listfill" | "designs" | "branding" | "scripts"
  | "data" | "versions" | "json" | "collaborators" | "notes" | "activity" | "analytics" | "clean" | "reports"
  | "search" | "plus" | "play" | "flask" | "download" | "export" | "user" | "bell" | "chevron-down" | "chevron-right" | "check" | "warning" | "info" | "close" | "home" | "grid" | "share" | "shield" | "logout" | "sparkle" | "chart" | "table" | "layers";

const P: Record<IconName, React.ReactNode> = {
  questions: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  flow: <><rect x="3" y="3" width="7" height="6" rx="1.5" /><rect x="14" y="15" width="7" height="6" rx="1.5" /><path d="M6.5 9v3.5a2 2 0 0 0 2 2h6a2 2 0 0 1 2 2V15" /></>,
  logic: <><path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v3" /><circle cx="6" cy="3" r="1.5" /><circle cx="18" cy="21" r="1.5" /><path d="M6 21v-9" /><circle cx="6" cy="21" r="1.5" /></>,
  variables: <><path d="M4 7c2 0 3 2 4 5s2 5 4 5M20 7c-2 0-3 2-4 5s-2 5-4 5" /><path d="M9 7h6" /></>,
  calc: <><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 7h8M8 12h3M13 12h3M8 16h3M13 16h3" /></>,
  quotas: <><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 3v9h9" /></>,
  listfill: <><path d="M4 6h10M4 12h7M4 18h10" /><path d="m16 12 4 4-4 4M20 16h-6" /></>,
  designs: <><path d="M9 3h6M10 3v6l-5 8a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 16.5l-5-8V3" /><path d="M7 16h10" /></>,
  branding: <><path d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9L9.5 8z" /></>,
  scripts: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" /></>,
  data: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  versions: <><path d="M12 3v9l3 3" /><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 4v4h4" /></>,
  json: <><path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3" /></>,
  collaborators: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.5a5 5 0 0 1 5.5 5" /></>,
  notes: <><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  analytics: <><path d="M4 20h16" /><path d="M6 16v-5M11 16V6M16 16v-8" /><circle cx="6" cy="9" r="1" fill="currentColor" stroke="none" /></>,
  clean: <><path d="m3 21 9-9M14 5l5 5" /><path d="M9.5 9.5 14 5l5 5-4.5 4.5a3 3 0 0 1-4.2 0l-.8-.8a3 3 0 0 1 0-4.2z" /><path d="m17 3 1 1M20 6l1 1" /></>,
  reports: <><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 14l3-3 2 2 3-4" /><path d="M8 18h8" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  play: <><path d="M7 4.5v15l12-7.5z" /></>,
  flask: <><path d="M10 3h4M11 3v6l-5.5 9A2.5 2.5 0 0 0 7.6 22h8.8a2.5 2.5 0 0 0 2.1-4L13 9V3" /><path d="M8 15h8" /></>,
  download: <><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></>,
  export: <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0v4l2 3H4l2-3z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12 5 5 9-10" />,
  warning: <><path d="M12 3 2.5 20h19z" /><path d="M12 10v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  home: <><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.3 13.2 7.4 4.3M15.7 6.5 8.3 10.8" /></>,
  shield: <><path d="M12 3 4 6v6c0 4.5 3.5 7.8 8 9 4.5-1.2 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  logout: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="m15 8 5 4-5 4M20 12H9" /></>,
  sparkle: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="m7 15 4-5 3 3 5-7" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10M15 10v10" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5M3 17l9 5 9-5" /></>,
};

export function Icon({ name, size = 18, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg className={`ico ${className ?? ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} focusable="false">
      {title && <title>{title}</title>}
      {P[name]}
    </svg>
  );
}
