import { existsSync } from "node:fs";
import { join } from "node:path";
import { screenById } from "@/lib/docs/screens";

/**
 * A STUDIO TOOL, AS IT LOOKS (Developer Docs phase 3): the captured screenshot named by `::: screen <id>`, with its
 * caption and where the tool is. Server-rendered; says so plainly when the picture has not been captured in this build.
 */
export function DocScreenFigure({ id }: { id: string }) {
  const s = screenById(id);
  if (!s) return <p className="docs-ex-missing">Screen “{id}” is not defined.</p>;
  const dir = join(process.cwd(), "public", "docs-media", "screens");
  const file = [`${id}.webp`, `${id}.png`].find((f) => existsSync(join(dir, f)));
  return (
    <figure className="docs-screen" data-testid="docs-screen" data-screen={id}>
      <figcaption className="docs-screen-head"><span className="docs-ex-kicker">In the Studio</span> <b>{s.title}</b></figcaption>
      {file ? (
        <a href={`/docs-media/screens/${file}`} target="_blank" rel="noreferrer" className="docs-screen-img" aria-label={`Open the ${s.title} screenshot full size`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/docs-media/screens/${file}`} alt={`${s.title} — ${s.caption}`} loading="lazy" />
        </a>
      ) : <p className="docs-ex-missing">This screenshot has not been captured in this build (run <code>node scripts/capture-docs-builder.mjs</code>).</p>}
      <p className="docs-ex-cap">{s.caption}</p>
    </figure>
  );
}
