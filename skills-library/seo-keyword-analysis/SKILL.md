---
name: seo-keyword-analysis
description: On-page SEO analysis — keyword density, meta tags, heading structure, content gaps, competitor comparison
metadata:
  openclaw:
    requires:
      bins: [curl, python3, jq]
---

# SEO Keyword Analysis Skill

On-page SEO analysis via `seo-analyze.sh`. Accepts a URL or local file path and outputs structured JSON covering title tags, meta descriptions, heading structure, keyword density, links, images, and an overall SEO score.

---

## 1. On-Page SEO Analysis

**Purpose:** Analyse a page's full SEO profile. Returns structured JSON you can pipe to `jq` or store for reporting.

**Command:**
```bash
# Analyse a live URL
seo-analyze.sh https://example.com

# Analyse a local HTML file
seo-analyze.sh /path/to/page.html

# With keyword tracking
seo-analyze.sh --keywords "organic coffee,fair trade" https://example.com
```

**JSON Output Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Source URL or file path |
| `title_tag.text` | string | Contents of `<title>` |
| `title_tag.length` | number | Character count of title |
| `title_tag.keyword_present` | bool | True if any target keyword appears in title |
| `meta_description.text` | string | Contents of `<meta name="description">` |
| `meta_description.length` | number | Character count of meta description |
| `headings.h1_count` | number | Number of `<h1>` tags |
| `headings.h2_count` | number | Number of `<h2>` tags |
| `headings.h3_count` | number | Number of `<h3>` tags |
| `headings.h4_count` | number | Number of `<h4>` tags |
| `headings.h5_count` | number | Number of `<h5>` tags |
| `headings.h6_count` | number | Number of `<h6>` tags |
| `headings.h1_text` | array | Text of all H1 elements |
| `keyword_density` | object | Per-keyword stats (see Section 2) |
| `links.internal_count` | number | Internal links (same domain) |
| `links.external_count` | number | External links (different domain) |
| `images.total` | number | Total `<img>` tags |
| `images.with_alt` | number | Images with non-empty `alt` attribute |
| `images.coverage_pct` | number | `with_alt / total * 100` (0 if no images) |
| `meta.canonical` | string\|null | Canonical URL if present |
| `meta.og_title` | string\|null | `og:title` content |
| `meta.og_description` | string\|null | `og:description` content |
| `meta.og_image` | string\|null | `og:image` content |
| `meta.has_ld_json` | bool | Whether `<script type="application/ld+json">` is present |
| `seo_score` | number | Overall score 0–100 (see scoring below) |
| `warnings` | array | Human-readable warnings (empty if none) |

**SEO Score Thresholds:**

| Score | Status | Interpretation |
|-------|--------|----------------|
| 80–100 | Good | Page is well-optimised. Minor improvements possible. |
| 60–79 | Needs work | Several issues dragging score. Prioritise warnings list. |
| 40–59 | Poor | Significant gaps. Address meta tags and heading structure first. |
| 0–39 | Critical | Fundamental SEO elements missing. Likely invisible to search engines. |

**Actionable next steps after analysis:**
1. Pipe `warnings[]` to your task queue — each warning maps to a concrete fix.
2. If `seo_score < 60`: fix meta description and H1 before keyword optimisation.
3. If `images.coverage_pct < 80`: bulk-update `alt` attributes — quick win for accessibility and SEO.
4. If `links.internal_count < 3`: add contextual internal links to improve crawlability.
5. Run `--meta` flag for detailed remediation notes on each meta check.

---

## 2. Keyword Density Checker

**Purpose:** Measure how frequently target keywords appear and where they are placed. Density is the primary signal for over- and under-optimisation.

**Command:**
```bash
seo-analyze.sh --keywords "keyword one,keyword two,keyword three" https://example.com
```

**Density Formula:**
```
density_pct = (occurrences / total_words) * 100
```

Both exact-match and phrase-match counting are applied:
- **Exact match:** keyword treated as a literal substring (case-insensitive).
- **Phrase match:** for multi-word keywords, the full phrase must appear contiguously.

**Per-Keyword Output Fields (inside `keyword_density.<keyword>`):**

| Field | Type | Description |
|-------|------|-------------|
| `count` | number | Total occurrences in body text |
| `pct` | number | Density percentage |
| `in_title` | bool | Keyword found in `<title>` |
| `in_h1` | bool | Keyword found in any `<h1>` |
| `in_first_paragraph` | bool | Keyword found in first `<p>` tag |
| `in_body` | bool | Keyword found anywhere in body text |

**Density Warnings:**

| Condition | Warning |
|-----------|---------|
| `pct > 3.0` | `over_optimized` — keyword stuffing risk; reduce usage |
| `pct < 0.5` | `under_optimized` — too sparse; add more contextual usage |
| `0.5 ≤ pct ≤ 2.5` | No warning — ideal range |
| `2.5 < pct ≤ 3.0` | `density_high` — borderline; monitor |

**Example output excerpt:**
```json
{
  "keyword_density": {
    "organic coffee": {
      "count": 7,
      "pct": 1.8,
      "in_title": true,
      "in_h1": true,
      "in_first_paragraph": true,
      "in_body": true
    }
  }
}
```

---

## 3. Content Gap Analysis

**Purpose:** Identify which keywords are missing, underrepresented, or well-covered. Use this before a content refresh to prioritise writing effort.

**Command:**
```bash
# Keywords inline
seo-analyze.sh --gap "keyword one,keyword two,keyword three" https://example.com

# Keywords from file (one per line)
seo-analyze.sh --gap /path/to/keywords.txt https://example.com
```

**Output Categories (inside `content_gap`):**

| Category | Condition | Action |
|----------|-----------|--------|
| `missing` | Keyword not found anywhere on page | Add a dedicated section or paragraph targeting this keyword |
| `underrepresented` | Density `< 0.5%` | Expand existing mentions; weave keyword into body and subheadings |
| `well_covered` | Density `≥ 1.0%` | No action required |

**Example output:**
```json
{
  "content_gap": {
    "missing": ["fair trade certification", "single origin"],
    "underrepresented": ["coffee brewing guide"],
    "well_covered": ["organic coffee", "specialty roast"]
  }
}
```

**Actionable interpretation:**
- **`missing`** keywords = content opportunities. Create new H2 sections targeting each one.
- **`underrepresented`** keywords = strengthen existing paragraphs. Aim for 1–2% density.
- **`well_covered`** = confirm intent match (informational vs transactional) before adding more.

---

## 4. Meta Tag Validator

**Purpose:** Audit all meta elements in detail with pass/warn/fail status and specific remediation notes.

**Command:**
```bash
seo-analyze.sh --meta https://example.com
```

**Checks Performed (inside `meta_validation`):**

| Check | Pass Condition | Warn Condition | Fail Condition |
|-------|---------------|----------------|----------------|
| `title_length` | 50–60 chars | 30–49 or 61–70 chars | < 30 or > 70 chars, or Absent |
| `meta_description_length` | 150–160 chars | 120–149 or 161–175 chars | < 120 or > 175 chars, or Absent |
| `canonical_url` | Present | — | Absent |
| `og_title` | Present | — | Absent |
| `og_description` | Present | — | Absent |
| `og_image` | Present | — | Absent |
| `ld_json` | Present | — | Absent |

**Output per check:**
```json
{
  "meta_validation": {
    "title_length": {
      "status": "warn",
      "value": 65,
      "note": "Title is 65 chars — search engines truncate above 60. Shorten to 50–60 chars."
    },
    "canonical_url": {
      "status": "pass",
      "value": "https://example.com/page",
      "note": null
    },
    "og_image": {
      "status": "fail",
      "value": null,
      "note": "og:image absent — social shares will display no image. Add a 1200x630px image."
    }
  }
}
```

**Remediation notes by check:**

| Check | Remediation |
|-------|-------------|
| `title_length` fail | Add `<title>` tag with primary keyword near the start, 50–60 chars |
| `title_length` warn (too long) | Trim title; front-load the most important keyword phrase |
| `title_length` warn (too short) | Expand title to include brand or secondary keyword |
| `meta_description_length` fail | Add `<meta name="description" content="...">` with compelling copy |
| `meta_description_length` warn (too long) | Cut to 150–160 chars; keep core value proposition |
| `canonical_url` fail | Add `<link rel="canonical" href="...">` in `<head>` |
| `og_title` fail | Add `<meta property="og:title" content="...">` |
| `og_description` fail | Add `<meta property="og:description" content="...">` |
| `og_image` fail | Add `<meta property="og:image" content="https://...1200x630.jpg">` |
| `ld_json` fail | Add structured data block (`Article`, `Product`, or `WebPage` schema) |

---

## 5. Competitor Keyword Comparison

**Purpose:** Compare your page's keyword profile against a competitor URL to find gaps (their keywords you're missing) and advantages (your keywords they lack).

**Command:**
```bash
seo-analyze.sh --compare https://competitor.com https://your-site.com
```

**Requirements:** Both URLs must be publicly accessible. The script fetches both pages via `curl`. Paywalled or JS-rendered pages may return incomplete results.

**Output (inside `competitor_comparison`):**

| Field | Description |
|-------|-------------|
| `keywords_in_competitor_only` | Opportunities — competitor ranks for these, you don't |
| `keywords_in_target_only` | Advantages — you cover these, competitor doesn't |
| `keywords_in_both` | Shared keywords — compare densities to assess competitive position |

**Keyword extraction methodology:** The script tokenises the visible text of each page, strips stopwords, and counts unigrams and bigrams. Keywords with frequency ≥ 3 and length ≥ 4 chars are included in the profile.

**Example output:**
```json
{
  "competitor_comparison": {
    "target_url": "https://your-site.com",
    "competitor_url": "https://competitor.com",
    "keywords_in_competitor_only": ["brew ratio", "pour over", "coffee subscription"],
    "keywords_in_target_only": ["fair trade", "single origin espresso"],
    "keywords_in_both": {
      "organic coffee": { "target_pct": 1.8, "competitor_pct": 0.9 },
      "specialty roast": { "target_pct": 1.2, "competitor_pct": 2.1 }
    }
  }
}
```

**Actionable interpretation:**
- `keywords_in_competitor_only` = content gaps. Research intent for each — add content if intent matches your page.
- `keywords_in_target_only` = validate these are intentional. If they're important to your audience, you may have an SEO advantage.
- `keywords_in_both` with `competitor_pct > target_pct` = competitor outranking opportunity. Increase your coverage for those terms.

**Limitations:**
- JS-rendered pages (React, Angular, Next.js without SSR) return sparse HTML — results will undercount keywords.
- Frequency-based keyword extraction is lexical, not semantic. It won't cluster synonyms.
- Run comparison on stable pages — competitor sites change frequently.
