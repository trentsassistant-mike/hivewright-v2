---
name: social-media-toolkit
description: Social media platform reference — specs, formatting, hashtags, scheduling, content adaptation
metadata:
  openclaw:
    requires:
      bins: [jq]
---

# Social Media Toolkit

Platform reference, content adaptation patterns, hashtag strategy, and scheduling templates for social-media-manager, content-creator, and marketing-lead roles. Use `social-format.sh` for character count and hashtag validation before publishing.

---

## 1. Platform Specs

| Platform | Char Limit | Hashtags (Recommended) | Image Dimensions (Primary) | Video Max | Link Handling | Notes |
|----------|-----------|------------------------|---------------------------|-----------|---------------|-------|
| Twitter/X | 280 | 2–3 | 1200×675px (16:9) | 2m 20s | Links count as 23 chars via t.co | Threads extend reach; alt text supported |
| LinkedIn | 3,000 | 3–5 | 1200×627px | 10 min | Links in body, auto-preview | First 210 chars visible before "see more" |
| Instagram | 2,200 | 30 max (5 caption + 25 first comment) | 1080×1080px or 1080×1350px (4:5) | 90s (Reels) | No clickable links in captions — bio link only | Carousel up to 10 slides; Story links available |
| Facebook | 63,206 | 3–5 recommended | 1200×630px | 240 min | Links auto-preview with OG metadata | Shorter posts (40–80 chars) get more engagement |
| TikTok | 2,200 | 3–5 | 1080×1920px (9:16 vertical) | 10 min | Links in bio only | Hook in first 2s critical; trending sounds boost reach |
| Threads | 500 | 5 max | 1080×1080px or 1080×1350px | 5 min | Links as last line recommended | Lives in Instagram ecosystem; no algorithmic feed initially |
| Bluesky | 300 | 1–2 sparingly | 1000×1000px or 2000×1000px (landscape) | No native video (as of 2024) | Links auto-generate card preview | Decentralised; starter packs drive discovery |

---

## 2. Content Adapter Patterns

Transform existing content (typically a blog post) into platform-native formats.

### Blog → Twitter/X Thread

1. Extract 3–5 key insights from the blog post.
2. **Hook tweet** (≤240 chars): Rewrite the title as a question or bold claim. Add thread indicator: `🧵 Thread:`
3. **Insight tweets** (1–5): One insight per tweet. Include a stat or proof point if available. Number each: `2/`
4. **Closing tweet**: Summary sentence + link to full post + 2–3 hashtags.
5. Strip markdown, URLs, and internal links from body tweets.
6. Each tweet must stand alone — no "as I said above" references.

**Example hook pattern:**
> "Most founders get this wrong about content marketing 🧵 Thread:" *(question/claim format)*

---

### Blog → LinkedIn

1. **Intro** (≤150 chars): Must hook before the "see more" cut — lead with the most surprising stat or claim. No preamble.
2. **Body**: Line breaks every 2–3 sentences. White space is engagement. No dense paragraphs.
3. Strip all markdown (no `**bold**`, no `#headers`). Use emoji sparingly as bullet substitutes.
4. **CTA**: End with an open question to drive comments (e.g., "What's your experience with X?").
5. **Hashtags**: 3–5 professional/industry terms at the very end, on a separate line.
6. Remove internal blog links — LinkedIn deprioritises posts with external URLs; put links in first comment.

---

### Blog → Instagram

1. **Hook** (first line, ≤125 chars visible before "more"): Lead with the most compelling takeaway. Use a statement, not a question.
2. **Body**: 3–5 bullet points or short sentences. Use line breaks generously. Each point ≤ 1 line.
3. **CTA**: "Save this post" or "Tag someone who needs this" drives algorithmic boost.
4. **Caption hashtags**: 5 niche + relevant tags in caption body.
5. **First comment hashtags**: Post 20–25 additional hashtags immediately after publishing to keep caption clean.
6. No URLs — direct to bio link or "link in bio."

---

### Blog → Threads

1. Take the single strongest insight from the blog — the one sentence most likely to spark a reply.
2. Expand to 1–3 sentences, ≤500 chars total.
3. 1–2 inline hashtags only (Threads penalises hashtag spam).
4. Optional: end with a question to encourage threading.
5. Link at end if included — keep as the final element.

---

### Blog → Bluesky

1. Distil to one punchy paragraph, ≤280 chars (leave 20 chars buffer for link if including one).
2. 0–1 hashtags — only use if the tag has active community usage.
3. No emoji overload — Bluesky skews tech/writer audience; substance over style.
4. If sharing a link, the auto-card handles preview — don't repeat the title in the text.

---

## 3. Hashtag Guidelines

### Per-Platform Limits and Strategy

| Platform | Max Allowed | Recommended Range | Optimal Strategy | Tiers to Include |
|----------|------------|-------------------|-----------------|-----------------|
| Instagram | 30 | 5 in caption, 25 in first comment | Mix across all 4 tiers; niche-heavy | High (3) + Mid (10) + Niche (12) + Brand (5) |
| Twitter/X | No hard limit | 2–3 | Mid-volume or trending; avoid overuse | Mid (2) or Trending (1–2) |
| LinkedIn | No hard limit | 3–5 | Professional/industry terms; no trending culture | Mid (2) + Niche (2) + Brand (1) |
| TikTok | No hard limit | 3–5 in caption | Mix trending + niche + 1 challenge tag if relevant | Trending (1) + Niche (2) + Challenge (1) |
| Threads | 5 max | 1–2 inline | Community-driven; avoid hashtag-only posts | Niche (1–2) |
| Bluesky | No hard limit | 1–2 if any | Community-driven; use only where active | Niche (1) |
| Facebook | No hard limit | 3–5 recommended | Branded + broad topic | Brand (2) + Mid (2) |

### Hashtag Tier Definitions

| Tier | Volume | Role | Example |
|------|--------|------|---------|
| **High-volume** | 1M+ posts | Awareness reach, competitive | `#marketing`, `#hive` |
| **Mid-volume** | 100K–1M posts | Targeted reach, less noise | `#contentmarketing`, `#solopreneur` |
| **Niche** | 10K–100K posts | Highly targeted, engaged audience | `#copyblogger`, `#linkedintips` |
| **Brand/Specific** | <10K posts | Own brand, campaign, event | `#YourBrandName`, `#CampaignTag` |

**Instagram mixing example (30 tags):**
- 3 high-volume: `#marketing #hive #entrepreneur`
- 10 mid-volume: `#contentmarketing #socialmediatips #digitalmarketing` *(etc.)*
- 12 niche: `#linkedingrowth #contentcreatortips` *(etc.)*
- 5 brand/specific: `#YourBrand #CampaignName` *(etc.)*

**Key rules:**
- Never use banned or broken hashtags (Instagram ghostbans accounts using flagged tags).
- Rotate hashtag sets — using identical sets on every post triggers reduced reach.
- Research tags before use: check recent post volume and content relevance.

---

## 4. Posting Schedule Templates

### Optimal Posting Times

| Platform | Best Days | Best Times (Local TZ) | Recommended Frequency/Week |
|----------|-----------|----------------------|---------------------------|
| Twitter/X | Tue, Wed, Thu | 8–10am, 12–1pm, 5–6pm | 3–7x (threads count as 1) |
| LinkedIn | Tue, Wed, Thu | 7–9am, 12pm, 5–6pm | 2–5x |
| Instagram | Mon, Wed, Fri | 9–11am, 1–3pm, 7–9pm | 3–7x (Feed); Daily (Stories) |
| Facebook | Wed, Thu, Fri | 9am–1pm | 1–3x |
| TikTok | Tue, Thu, Fri | 7–9am, 12–3pm, 7–9pm | 3–7x |
| Threads | Mon–Fri | 9am–12pm, 6–9pm | 1–3x |
| Bluesky | Tue, Wed, Thu | 8–11am, 12–2pm | 1–3x |

*Times are averages; test with your specific audience using platform analytics.*

### 7-Day Launch Template

| Day | Platform | Content Type | Post Copy Hint | Hashtag Set | Status |
|-----|----------|-------------|----------------|-------------|--------|
| Day 1 | Twitter/X | Announcement thread | "We're launching X — here's what it does 🧵" | Brand + 2 mid | Draft |
| Day 1 | LinkedIn | Long-form announcement | Problem → solution → CTA; 150-char hook | 3–5 industry | Draft |
| Day 2 | Instagram | Visual product reveal | Hook: "This changes how you [do X]" + carousel | 5 caption + 25 comment | Draft |
| Day 2 | TikTok | Behind-the-scenes/demo | "POV: you just discovered X" hook | Trending + niche | Draft |
| Day 3 | Facebook | Community question | "We built X because [pain point] — does this resonate?" | 3–5 topic | Draft |
| Day 4 | Threads | Insight snippet | Strongest 1-sentence takeaway from blog | 1–2 inline | Draft |
| Day 4 | Bluesky | Sharp take | Punchy ≤280-char distillation | 0–1 | Draft |
| Day 5 | Twitter/X | Engagement reply prompt | Quote-tweet Day 1 + "What questions do you have?" | — | Draft |
| Day 6 | LinkedIn | Social proof post | Early feedback or use case story | 3–4 niche | Draft |
| Day 7 | All | Roundup/link post | "In case you missed it" + link to full announcement | Platform-specific | Draft |

### 30-Day Content Skeleton

| Week | Theme | Twitter/X | LinkedIn | Instagram | Facebook | TikTok | Threads | Bluesky |
|------|-------|-----------|----------|-----------|----------|--------|---------|---------|
| Wk 1 | Launch & awareness | 3 threads (announce, FAQ, insights) | 2 posts (announce, founder story) | 2 carousels (product, benefits) | 1 post (announce) | 2 videos (demo, BTS) | 3 snippets | 2 takes |
| Wk 2 | Education & value | 3 threads (how-to, stats, tips) | 2 posts (use case, listicle) | 2 posts (tips carousel, quote) | 1 post (tip) | 2 videos (tutorial, tip) | 2 snippets | 2 takes |
| Wk 3 | Social proof | 3 tweets (testimonials, case study) | 2 posts (case study, milestone) | 3 posts (UGC, before/after, result) | 1 post (testimonial) | 2 videos (reaction, results) | 2 snippets | 1 take |
| Wk 4 | Conversion & CTA | 3 threads (objections, comparison, offer) | 2 posts (ROI post, direct CTA) | 2 posts (offer, testimonial) | 2 posts (offer, reminder) | 2 videos (offer reveal, final push) | 2 snippets | 2 takes |

---

## 5. Content Calendar Builder

Use this template to plan, track, and publish across all platforms.

**Instructions:**
1. Copy the table below into your planning tool or spreadsheet.
2. Fill `Draft Copy` with platform-adapted copy from Section 2.
3. Set `Hashtags` using Section 3 strategy for each platform.
4. Mark `Visual Required` if the platform requires an image/video (always for Instagram/TikTok).
5. Confirm `Scheduled Time` aligns with Section 4 optimal posting windows.
6. Update `Status` as work progresses: Draft → Scheduled → Published.

**Content Calendar Template:**

| Date | Platform | Content Type | Draft Copy | Hashtags | Visual Required | Scheduled Time | Status |
|------|----------|-------------|------------|----------|----------------|----------------|--------|
| YYYY-MM-DD | twitter | Thread | [hook tweet text] | #tag1 #tag2 | No | 09:00 local | Draft |
| YYYY-MM-DD | linkedin | Long-form post | [150-char hook...] | #tag1 #tag2 | Optional | 08:00 local | Draft |
| YYYY-MM-DD | instagram | Carousel | [125-char hook...] | #tag1 #tag2 | Yes (10 slides) | 10:00 local | Draft |
| YYYY-MM-DD | facebook | Post | [question or stat...] | #tag1 #tag2 | Optional | 11:00 local | Draft |
| YYYY-MM-DD | tiktok | Video | [hook script line] | #tag1 #tag2 | Yes (video) | 08:00 local | Draft |
| YYYY-MM-DD | threads | Snippet | [1–3 sentences] | #tag1 | No | 09:30 local | Draft |
| YYYY-MM-DD | bluesky | Take | [≤280-char text] | #tag1 | Optional | 09:00 local | Draft |

**Status values:** `Draft` → `Approved` → `Scheduled` → `Published` → `Archived`

---

## social-format.sh Reference

Validate character counts and hashtag limits before publishing.

```bash
# Basic check
social-format.sh --platform twitter --text 'Your post copy here'

# With hashtags
social-format.sh --platform instagram --text 'Caption text here' --hashtags '#tag1 #tag2 #tag3 #tag4 #tag5'

# Check only (no output, exit code only)
social-format.sh --platform threads --text 'Post text' --check-only
```

**Exit codes:** `0` = PASS (within limit), `1` = FAIL (exceeds limit or invalid args)
