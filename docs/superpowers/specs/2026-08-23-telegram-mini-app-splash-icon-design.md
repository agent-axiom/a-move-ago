# A MOVE AGO Telegram Mini App Splash Icon Design

## Goal

Create a dedicated vector icon for the Telegram Mini App launch screen. The
icon must load cleanly in Telegram's light and dark themes, remain recognizable
at the rendered splash size, and visually connect to the approved A MOVE AGO
bot logo without embedding that logo's square background or color treatment.

## Platform constraints

- Deliver an SVG with `viewBox="0 0 512 512"`.
- Use exactly one compound `<path>` element.
- Do not include a background rectangle, text, groups, masks, clipping paths,
  strokes, transforms, filters, gradients, embedded images, or animation.
- Flatten every visible shape into the single path's `d` value.
- Treat the path as a monochrome mask. Telegram controls the displayed icon
  color for each theme, so brand colors do not belong in this asset.
- Prefer SVG over the supported WEBP or TGS fallback because Telegram warns
  that automatic outline generation can reduce quality.

These constraints follow Telegram's launch-screen interface and its
[512 × 512 vector-thumbnail format](https://core.telegram.org/api/files#vector-thumbnails).

## Approved visual direction

Use **Mono v4**, selected from three alternatives:

- a centered, simplified chess-knight silhouette;
- one open counterclockwise arc outside the knight;
- the arc covers approximately one half of a circle, beginning in the
  lower-right sector, curving over the top, and ending in a compact arrowhead
  in the upper-left sector;
- the open arc communicates one concise move backward rather than a complete
  refresh cycle;
- the arrow never touches or crosses the knight.

The knight and arrow remain separate visible silhouettes but are encoded as
subpaths inside the same compound SVG path.

## Geometry and legibility

- Center the combined mark optically on the 512 × 512 canvas.
- Let the mark occupy approximately 80–85% of the canvas, with balanced outer
  margins; Telegram publishes no separate safe-area percentage.
- Use a strong, simplified knight profile with a stable base and no tiny eye,
  mane, or bevel details.
- Give the arc a uniform outlined thickness that survives reduction without
  looking like a heavy refresh icon.
- Use a compact geometric arrowhead large enough to preserve the
  counterclockwise direction at small size.
- Balance the negative space between the arc and the knight so the two shapes
  remain distinct when rendered at approximately 78 × 78 and 100 × 100.

## Deliverable

Create `assets/branding/telegram-mini-app-splash-icon.svg`. Keep generated PNG
previews temporary; the upload-ready SVG is the only project asset required.

## Validation

Validate all of the following before handoff:

1. The SVG is valid XML and uses the 512 × 512 view box.
2. The document contains exactly one `<path>` and no forbidden elements.
3. The path contains both the knight and the open counterclockwise arc.
4. The rendered mark is centered, unclipped, and clear on both light and dark
   backgrounds.
5. The knight, arc, and arrow direction remain distinguishable at 78 × 78 and
   100 × 100.
6. The file contains no text, metadata, signature, watermark, or raster data.
