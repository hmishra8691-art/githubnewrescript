"use client";
import React from "react";
import { resolveMediaUrl, isAllowedEmbed, mediaDisplayStyle, type ResolvedMedia } from "@rescript/engine";
import type { MediaDisplay } from "@rescript/schema";

/**
 * The `display` object (size, fit, alignment, playback — set with controls in
 * the Studio) becomes inline style through the engine's one computation, on
 * top of whatever `style` the caller passes. Its playback flags fill in the
 * caller's when the caller left them unset.
 */
function withDisplay(display: MediaDisplay | null | undefined, style: React.CSSProperties | undefined): React.CSSProperties | undefined {
  if (!display) return style;
  return { ...(style ?? {}), ...(mediaDisplayStyle(display) as React.CSSProperties) };
}

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
  /** size / fit / alignment, from the Studio's controls */
  display?: MediaDisplay | null;
  /** render nothing but an image (or the failure note) — for clickable stimuli */
  imageOnly?: boolean;
  /** called when the image fails to load (hotspot renderers disable themselves) */
  onBroken?: () => void;
};

export function SafeImage({ src, imageOnly, onBroken, alt = "", className, style: rawStyle, display, ...rest }: ImgProps) {
  const media = React.useMemo(() => resolveMediaUrl(src), [src]);
  const style = withDisplay(display, rawStyle);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [src]);

  if (media.kind === "unsupported") {
    return <MediaNote className={className} style={style} text={media.reason ?? "Unable to load image"} data-testid="media-unsupported" />;
  }
  if (media.kind !== "image") {
    if (imageOnly) return <MediaNote className={className} style={style} text="Unable to load image — this URL is a video, not an image." data-testid="media-not-image" />;
    return <MediaEmbed url={src} className={className} style={rawStyle} display={display} />;
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
  url, className, style: rawStyle, title, alt, controls: rawControls, autoPlay: rawAutoPlay, muted: rawMuted, loop: rawLoop, onEnded, display,
}: {
  url: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  /** size / fit / alignment / playback, from the Studio's controls */
  display?: MediaDisplay | null;
  title?: string;
  /**
   * What a screen reader says about this media. Falls back to `title` — the
   * question's own text — rather than to the empty string, so a stimulus is
   * never announced as an unnamed image. Pass "" deliberately for decoration.
   */
  alt?: string;
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
}) {
  const media = React.useMemo(() => resolveMediaUrl(url), [url]);
  if (!url) return null;
  const style = withDisplay(display, rawStyle);
  const controls = rawControls ?? display?.controls ?? true;
  const autoPlay = rawAutoPlay ?? display?.autoplay;
  // a browser only honours autoplay when the element is muted; say so in the markup
  const muted = rawMuted ?? display?.muted ?? (autoPlay ? true : undefined);
  const loop = rawLoop ?? display?.loop;
  return <ResolvedView media={media} className={className} style={style} title={title} alt={alt} controls={controls} autoPlay={autoPlay} muted={muted} loop={loop} poster={display?.poster} onEnded={onEnded} />;
}

function ResolvedView({ media, className, style, title, alt, controls, autoPlay, muted, loop, poster, onEnded }: {
  media: ResolvedMedia; className?: string; style?: React.CSSProperties; title?: string; alt?: string;
  controls?: boolean; autoPlay?: boolean; muted?: boolean; loop?: boolean; poster?: string; onEnded?: () => void;
}) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [media.original]);
  const cls = ["rs-embed", className].filter(Boolean).join(" ");

  switch (media.kind) {
    case "image":
      if (broken) return <MediaNote className={cls} style={style} text="Unable to load image" data-testid="media-broken" title={media.url} />;
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={cls} style={style} src={media.url} alt={alt ?? title ?? ""} loading="lazy" referrerPolicy="no-referrer"
          onError={() => setBroken(true)} data-media-provider={media.provider} data-testid="media-image" />
      );
    case "video":
      if (broken) return <MediaNote className={cls} style={style} text={media.mimeType?.startsWith("audio/") ? "Unable to load audio" : "Unable to load video"} data-testid="media-broken" title={media.url} />;
      /*
       * An audio clip is an <audio> element — a player bar, not a black
       * rectangle with a play button in it. It used to go through <video>,
       * which "works" and looks like a broken film.
       */
      if (media.mimeType?.startsWith("audio/")) {
        return (
          <audio className={`${cls} rs-audio`} style={style} src={media.url} controls={controls} autoPlay={autoPlay} muted={muted} loop={loop}
            aria-label={alt ?? title ?? undefined} preload="metadata" onEnded={onEnded} onError={() => setBroken(true)} data-media-provider={media.provider} data-testid="media-audio">
            <source src={media.url} type={media.mimeType} />
          </audio>
        );
      }
      return (
        <video className={cls} style={style} src={media.url} controls={controls} autoPlay={autoPlay} muted={muted} loop={loop} poster={poster}
          aria-label={alt ?? title ?? undefined}
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
