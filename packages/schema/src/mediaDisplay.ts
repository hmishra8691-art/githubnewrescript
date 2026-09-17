import { z } from "zod";

/**
 * HOW A PIECE OF MEDIA IS SHOWN — size, fit, alignment, playback.
 *
 * One object for an image, a video or an audio clip wherever one appears: a
 * question's stimulus (`settings.mediaDisplay`), the branding logo
 * (`branding.logoDisplay`), and — serialised into a `style` attribute — a
 * picture or player inserted into rich text. The Studio edits it with
 * controls, not CSS; the renderer turns it into CSS in one place
 * (`mediaDisplayStyle` in the engine), so what the builder shows and what the
 * respondent sees are the same computation.
 *
 * Lengths are CSS lengths as strings (`"300px"`, `"60%"`, `"auto"`), which is
 * what a person types and what CSS takes; a bare number is read as pixels.
 * Every field is optional, and an absent object means exactly what it meant
 * before this existed: the stylesheet decides.
 */
const Length = z.union([z.string(), z.number()]).optional();

export const MediaDisplay = z.object({
  width: Length,
  height: Length,
  maxWidth: Length,
  maxHeight: Length,
  /** how the picture fills the box it is given — `contain` never crops, `cover` never letterboxes */
  fit: z.enum(["contain", "cover", "fill", "none", "scale-down"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  /** keep the intrinsic proportions when only one dimension is set (default on) */
  keepRatio: z.boolean().optional(),
  /** scale down on narrow screens (max-width: 100%) — default on */
  responsive: z.boolean().optional(),
  /* ---- video / audio */
  autoplay: z.boolean().optional(),
  controls: z.boolean().optional(),
  muted: z.boolean().optional(),
  loop: z.boolean().optional(),
  /** a still to show before a video plays */
  poster: z.string().optional(),
  /** extra CSS declarations, `prop: value; prop: value`, applied last; sanitised */
  css: z.string().optional(),
});
export type MediaDisplay = z.infer<typeof MediaDisplay>;
