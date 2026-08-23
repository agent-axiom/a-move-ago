# A MOVE AGO Telegram Bot Logo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate, validate, and save the approved A MOVE AGO Telegram bot logo as a project-owned PNG asset.

**Architecture:** Use the built-in image generation tool for one square logo based on the approved design brief. Inspect the generated mark at full size and Telegram-avatar scale, then copy the selected image into a dedicated branding asset directory without replacing an existing file.

**Tech Stack:** Built-in image generation, local image inspection, macOS image metadata tools, PNG

---

### Task 1: Generate the approved logo

**Files:**
- Reference: `docs/superpowers/specs/2026-08-23-telegram-bot-logo-design.md`
- Create: built-in generated image under the Codex generated-images directory

- [ ] **Step 1: Generate one square logo from the approved brief**

Use the built-in image generation tool with this prompt:

```text
Use case: logo-brand
Asset type: Telegram bot avatar, square 1:1
Primary request: Create a minimal logo for A MOVE AGO, a reverse-chess game in which players reconstruct the position before the last move.
Scene/backdrop: deep graphite-black background, clean and uncluttered
Subject: one bold warm-ivory chess knight completely enclosed inside one thick copper-gold counterclockwise arrow; the arrow forms a nearly closed circular ring around the knight, with a clear arrowhead pointing backward in time
Style/medium: polished vector-friendly brand mark, strong flat geometry, subtle background depth only
Composition/framing: centered and symmetrical; generous breathing room; both the knight and the entire surrounding arrow fit safely inside Telegram's circular avatar crop; highly legible at 40 px
Lighting/mood: intellectual, mysterious, restrained, contemporary
Color palette: graphite black #151718, warm ivory #f5f2ea, copper-gold harmonizing with warm wood tones
Constraints: the knight must be inside the circular arrow; the arrow must surround the knight rather than sit beside, behind, or across it; counterclockwise direction must be unmistakable
Avoid: text, letters, numbers, additional pieces, board coordinates, ornate heraldry, photorealism, glossy 3D effects, thin lines, tiny details, outer border, signature, watermark, clockwise refresh icon
```

Expected: one square logo with a clearly readable ivory knight inside a copper-gold counterclockwise ring-arrow.

- [ ] **Step 2: Inspect the full-size result**

Open the generated image and verify all of the following:

- the knight is the only chess piece;
- the arrow fully surrounds the knight;
- the arrowhead reads as counterclockwise;
- no text, signature, or watermark appears;
- the mark remains centered with room for Telegram's circular crop.

Expected: every requirement passes. If one fails, generate one corrected iteration that changes only the failed requirement and inspect it again.

### Task 2: Save and validate the project asset

**Files:**
- Create: `assets/branding/telegram-bot-logo.png`
- Create temporarily: `/tmp/a-move-ago-telegram-logo-40.png`

- [ ] **Step 1: Create the branding directory and copy the selected image**

Run:

```bash
export A_MOVE_AGO_GENERATED_LOGO_PATH="$(find /Users/if/.codex/generated_images -type f -name '*.png' -mmin -5 -print -quit)"
test -n "$A_MOVE_AGO_GENERATED_LOGO_PATH"
test ! -e assets/branding/telegram-bot-logo.png
mkdir -p assets/branding
cp "$A_MOVE_AGO_GENERATED_LOGO_PATH" assets/branding/telegram-bot-logo.png
```

Expected: the generation step produced a recent PNG,
`assets/branding/telegram-bot-logo.png` exists, and no existing asset was
overwritten.

- [ ] **Step 2: Verify the saved image metadata**

Run:

```bash
sips -g pixelWidth -g pixelHeight -g format assets/branding/telegram-bot-logo.png
```

Expected: width equals height and the format is PNG.

- [ ] **Step 3: Check small-avatar legibility**

Run:

```bash
sips -z 40 40 assets/branding/telegram-bot-logo.png --out /tmp/a-move-ago-telegram-logo-40.png
```

Open `/tmp/a-move-ago-telegram-logo-40.png` and verify that the knight silhouette and counterclockwise ring-arrow are still distinguishable.

Expected: both elements remain clear at 40 × 40 px.

- [ ] **Step 4: Check the workspace change**

Run:

```bash
git status --short assets/branding/telegram-bot-logo.png
```

Expected:

```text
?? assets/branding/telegram-bot-logo.png
```

Leave the generated asset uncommitted so the user can approve the final image before deciding whether to commit it.
