# A MOVE AGO Telegram Mini App Splash Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and verify an upload-ready 512 × 512 single-path SVG splash icon for the A MOVE AGO Telegram Mini App.

**Architecture:** Encode the approved Mono v4 knight and open counterclockwise arc as subpaths inside one SVG `<path>`. Validate the XML structure deterministically, then rasterize temporary light- and dark-theme previews at Telegram-like sizes for visual inspection.

**Tech Stack:** SVG, XML, `xmllint`, ImageMagick

---

### Task 1: Create the single-path splash icon

**Files:**
- Reference: `docs/superpowers/specs/2026-08-23-telegram-mini-app-splash-icon-design.md`
- Create: `assets/branding/telegram-mini-app-splash-icon.svg`

- [ ] **Step 1: Verify that the destination is unused**

Run:

```bash
test ! -e assets/branding/telegram-mini-app-splash-icon.svg
```

Expected: exit code 0, confirming that the new asset will not overwrite an
existing file.

- [ ] **Step 2: Create the exact SVG**

Create `assets/branding/telegram-mini-app-splash-icon.svg` with this content:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path d="M242 124c38 6 70 30 84 64 16 38 10 86-16 118l16 48H174l14-44c6-20 10-42 6-62l-36 28c-18 14-46 4-50-18-2-14 8-26 18-38l56-68-16-42 58 28 18-14Zm-68 242h158l16 24H156l18-24ZM408 362c36-106-16-226-118-270-54-24-118-20-168 10l26 4-14 30-60-34 34-60 28 16-20 12c60-34 134-38 200-10 122 52 184 196 142 322l-50-20Z"/>
</svg>
```

Expected: one monochrome compound path containing the knight, base, and open
counterclockwise arc.

- [ ] **Step 3: Validate XML and platform structure**

Run:

```bash
xmllint --noout assets/branding/telegram-mini-app-splash-icon.svg
xmllint --xpath 'string(/*[local-name()="svg"]/@viewBox)' assets/branding/telegram-mini-app-splash-icon.svg
xmllint --xpath 'count(/*[local-name()="svg"]/*[local-name()="path"])' assets/branding/telegram-mini-app-splash-icon.svg
xmllint --xpath 'count(//*[local-name()!="svg" and local-name()!="path"])' assets/branding/telegram-mini-app-splash-icon.svg
xmllint --xpath 'count(/*[local-name()="svg"]/*[local-name()="path"]/@*)' assets/branding/telegram-mini-app-splash-icon.svg
```

Expected outputs, in order:

```text
0 0 512 512
1
0
1
```

The first command produces no output and exits successfully. The remaining
values confirm the required view box, one path, no forbidden child elements,
and only the path's `d` attribute.

### Task 2: Render and inspect Telegram-sized previews

**Files:**
- Read: `assets/branding/telegram-mini-app-splash-icon.svg`
- Create temporarily: `/tmp/a-move-ago-splash-mask-78.png`
- Create temporarily: `/tmp/a-move-ago-splash-light-78.png`
- Create temporarily: `/tmp/a-move-ago-splash-mask-100.png`
- Create temporarily: `/tmp/a-move-ago-splash-dark-100.png`

- [ ] **Step 1: Render transparent masks at target sizes**

Run:

```bash
magick -background none assets/branding/telegram-mini-app-splash-icon.svg -resize 78x78 /tmp/a-move-ago-splash-mask-78.png
magick -background none assets/branding/telegram-mini-app-splash-icon.svg -resize 100x100 /tmp/a-move-ago-splash-mask-100.png
```

Expected: both commands exit successfully and produce transparent PNG masks.

- [ ] **Step 2: Build light- and dark-theme previews**

Run:

```bash
magick /tmp/a-move-ago-splash-mask-78.png -fill '#7d5a42' -colorize 100 -background '#f5f2ea' -flatten /tmp/a-move-ago-splash-light-78.png
magick /tmp/a-move-ago-splash-mask-100.png -fill '#d9a86c' -colorize 100 -background '#151718' -flatten /tmp/a-move-ago-splash-dark-100.png
```

Expected: a 78 × 78 light-theme preview and a 100 × 100 dark-theme preview.

- [ ] **Step 3: Verify preview dimensions**

Run:

```bash
magick identify -format '%wx%h\n' /tmp/a-move-ago-splash-light-78.png /tmp/a-move-ago-splash-dark-100.png
```

Expected:

```text
78x78
100x100
```

- [ ] **Step 4: Inspect both previews**

Open both preview PNGs and confirm:

- the knight and open arc are centered and unclipped;
- the knight reads as a chess piece at both sizes;
- the arrowhead clearly indicates counterclockwise motion;
- the arc remains separate from the knight;
- the symbol is neither too small nor visually heavy;
- both theme combinations have strong contrast.

Expected: every check passes. If one check fails, adjust only the corresponding
SVG geometry, rerun Tasks 1 Step 3 and Task 2, and inspect again.

### Task 3: Review and commit the upload-ready asset

**Files:**
- Create: `assets/branding/telegram-mini-app-splash-icon.svg`

- [ ] **Step 1: Check the repository diff**

Run:

```bash
git diff --check
git status --short assets/branding/telegram-mini-app-splash-icon.svg
```

Expected status:

```text
?? assets/branding/telegram-mini-app-splash-icon.svg
```

- [ ] **Step 2: Commit only the approved splash SVG**

Run:

```bash
git add assets/branding/telegram-mini-app-splash-icon.svg
git commit -m "feat: add telegram mini app splash icon"
```

Expected: one commit containing only the upload-ready SVG; temporary PNG
previews remain outside the repository.
