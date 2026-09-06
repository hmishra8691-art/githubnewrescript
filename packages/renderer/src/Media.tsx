"use client";
import React from "react";
import { resolveMediaUrl, isAllowedEmbed, type ResolvedMedia } from "@rescript/engine";

/**
 * The two media elements every renderer uses instead of a raw `<img>` or
 * `<video>`. Both go through `resolveMediaUrl` (engine/media.ts), so a
 * YouTube watch link, a Google Drive share link, a CDN image with a signed
 * query string and an mp4 all render as the right thing — and a URL that
 * cannot be rendered says so instead of leaving a broken-image icon.
 *
 *   <SafeImage src=… />   an image slot (option images, stimuli). Renders an
 *                         <img> with a graceful failure state; when the URL is
 *                         really a video or an embed it renders that instead,
 *                         unless `imageOnly` (hotspot / annotation stimuli
 *                         need pixels to click on).
 *   <MediaEmbed url=… />  a media slot (question / block media, attachments):
 *                         whatever the URL is — image, <video>, allow-listed
 *                         iframe — sized to its container.
 */

type ImgProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  src: string | null | undefined;
  /** render nothing but an image (or the failure note) — for clickable stimuli */
  imageOnly?: boolean;
  /** called when the image fails to load (hotspot renderers disable themselves) */
  onBroken?: () => void;
};

export function SafeImage({ src, imageOnly, onBroken, alt = "", className, style, ...rest }: ImgProps) {
  const media = React.useMemo(() => resolveMediaUrl(src), [src]);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [src]);

  if (media.kind === "unsupported") {
    return <MediaNote className={className} style={style} text={media.reason ?? "Unable to load image"} data-testid="media-unsupported" />;
  }
  if (media.kind !== "image") {
    if (imageOnly) return <MediaNote className={className} style={style} text="Unable to load image — this URL is a video, not an image." data-testid="media-not-image" />;
    return <MediaEmbed url={src} className={className} style={style} />;
  }
  if (broken) {
    return <MediaNote className={className} style={style} text="Unable to load image" data-testid="media-broken" title={media.url} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...rest}
      className={className}
      style={style}
      src={media.url}
      alt={alt}
      loading={rest.loading ?? "lazy"}
      referrerPolicy="no-referrer"
      onError={() => { setBroken(true); onBroken?.(); }}
      data-media-provider={media.provider}
    />
  );
}

export function MediaEmbed({
  url, className, style, title, controls = true, autoPlay, muted, loop, onEnded,
}: {
  url: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
}) {
  const media = React.useMemo(() => resolveMediaUrl(url), [url]);
  if (!url) return null;
  return <ResolvedView media={media} className={className} style={style} title={title} controls={controls} autoPlay={autoPlay} muted={muted} loop={loop} onEnded={onEnded} />;
}

function ResolvedView({ media, className, style, title, controls, autoPlay, muted, loop, onEnded }: {
  media: ResolvedMedia; className?: string; style?: React.CSSProperties; title?: string;
  controls?: boolean; autoPlay?: boolean; muted?: boolean; loop?: boolean; onEnded?: () => void;
}) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [media.original]);
  const cls = ["rs-embed", className].filter(Boolean).join(" ");

  switch (media.kind) {
    case "image":
      if (broken) return <MediaNote className={cls} style={style} text="Unable to load image" data-testid="media-broken" title={media.url} />;
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={cls} style={style} src={media.url} alt={title ?? ""} loading="lazy" referrerPolicy="no-referrer"
          onError={() => setBroken(true)} data-media-provider={media.provider} data-testid="media-image" />
      );
    case "video":
      if (broken) return <MediaNote className={cls} style={style} text="Unable to load video" data-testid="media-broken" title={media.url} />;
      return (
        <video className={cls} style={style} src={media.url} controls={controls} autoPlay={autoPlay} muted={muted} loop={loop}
          playsInline preload="metadata" onEnded={onEnded} onError={() => setBroken(true)} data-media-provider={media.provider} data-testid="media-video">
          {media.mimeType && <source src={media.url} type={media.mimeType} />}
        </video>
      );
    case "embed": {
      if (!media.url || !isAllowedEmbed(media.url)) {
        return <MediaNote className={cls} style={style} text="This site cannot be embedded in a survey." data-testid="media-unsupported" />;
      }
      return (
        <div className={`${cls} rs-embed-frame`} style={style} data-media-provider={media.provider} data-testid="media-embed">
          <iframe
            src={media.url}
            title={title ?? `${media.provider} media`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            loading="lazy"
          />
          {media.note && <div className="rs-media-note rs-media-note-small">{media.note}</div>}
        </div>
      );
    }
    default:
      return <MediaNote className={cls} style={style} text={media.reason ?? "Unable to load media"} data-testid="media-unsupported" />;
  }
}

function MediaNote({ text, className, style, title, ...rest }: { text: string; className?: string; style?: React.CSSProperties; title?: string; "data-testid"?: string }) {
  return (
    <div className={["rs-media-note", className].filter(Boolean).join(" ")} style={style} title={title} role="img" aria-label={text} {...rest}>
      <span aria-hidden>🖼</span> {text}
    </div>
  );
}
