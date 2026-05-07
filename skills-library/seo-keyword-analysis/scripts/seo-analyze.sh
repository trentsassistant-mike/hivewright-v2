#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# seo-analyze.sh — On-page SEO analysis
#
# Usage:
#   seo-analyze.sh [flags] <URL|file>
#
# Flags:
#   --keywords kw1,kw2    Keyword density analysis
#   --gap kw1,kw2|file    Content gap analysis
#   --meta                Detailed meta tag validation
#   --compare URL2        Competitor keyword comparison
#
# Exit codes:
#   0 = success
#   1 = fetch error
#   2 = parse error
#   3 = invalid args
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
KEYWORDS=""
GAP_INPUT=""
META_MODE=false
COMPARE_URL=""
TARGET=""

usage() {
    cat >&2 <<'EOF'
Usage: seo-analyze.sh [flags] <URL|file>

Flags:
  --keywords kw1,kw2         Keyword density analysis (comma-separated)
  --gap kw1,kw2|/path/file   Content gap analysis (comma-separated or file path)
  --meta                     Detailed meta tag validation
  --compare URL2             Compare with competitor URL

Exit codes: 0=success  1=fetch error  2=parse error  3=invalid args
EOF
}

if [[ $# -lt 1 ]]; then
    usage
    exit 3
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --keywords)
            [[ $# -lt 2 ]] && { echo "Error: --keywords requires a value" >&2; exit 3; }
            KEYWORDS="$2"; shift 2 ;;
        --gap)
            [[ $# -lt 2 ]] && { echo "Error: --gap requires a value" >&2; exit 3; }
            GAP_INPUT="$2"; shift 2 ;;
        --meta)
            META_MODE=true; shift ;;
        --compare)
            [[ $# -lt 2 ]] && { echo "Error: --compare requires a value" >&2; exit 3; }
            COMPARE_URL="$2"; shift 2 ;;
        --help|-h)
            usage; exit 0 ;;
        -*)
            echo "Error: Unknown flag: $1" >&2; usage; exit 3 ;;
        *)
            if [[ -z "$TARGET" ]]; then
                TARGET="$1"
            else
                echo "Error: Unexpected argument: $1" >&2; usage; exit 3
            fi
            shift ;;
    esac
done

if [[ -z "$TARGET" ]]; then
    echo "Error: No URL or file path provided" >&2
    usage
    exit 3
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
_TMPDIR=""
_cleanup() {
    [[ -n "$_TMPDIR" ]] && rm -rf "$_TMPDIR"
}
trap _cleanup EXIT

_get_tmpdir() {
    if [[ -z "$_TMPDIR" ]]; then
        _TMPDIR=$(mktemp -d)
    fi
    echo "$_TMPDIR"
}

# ---------------------------------------------------------------------------
# Fetch HTML
# ---------------------------------------------------------------------------
fetch_html() {
    local source="$1"
    local outfile="$2"

    if [[ "$source" == http://* || "$source" == https://* ]]; then
        local http_code
        http_code=$(curl -sL --max-time 15 -w "%{http_code}" -o "$outfile" "$source" 2>/dev/null) || {
            echo "Error: Connection failed for: ${source}" >&2
            exit 1
        }
        if [[ "$http_code" -lt 200 || "$http_code" -ge 400 ]]; then
            echo "Error: HTTP ${http_code} fetching: ${source}" >&2
            exit 1
        fi
    else
        # Local file
        if [[ ! -f "$source" ]]; then
            echo "Error: File not found: ${source}" >&2
            exit 1
        fi
        cp "$source" "$outfile"
    fi
}

# ---------------------------------------------------------------------------
# Python analysis — single embedded script handles all modes
# ---------------------------------------------------------------------------
run_analysis() {
    local html_file="$1"
    local source_label="$2"
    local keywords="$3"
    local gap_input="$4"
    local meta_mode="$5"
    local compare_html="$6"
    local compare_label="$7"

python3 - "$html_file" "$source_label" "$keywords" "$gap_input" "$meta_mode" "$compare_html" "$compare_label" <<'PYEOF'
import sys
import json
import re
import html as html_module
from html.parser import HTMLParser

# ---------------------------------------------------------------------------
# HTML parser
# ---------------------------------------------------------------------------
class SEOParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self.meta_description = ""
        self.canonical = None
        self.og = {}
        self.has_ld_json = False
        self.headings = {f"h{i}": [] for i in range(1, 7)}
        self.links = []
        self.images = []
        self.paragraphs = []
        self.body_text_parts = []

        self._in_title = False
        self._in_heading = None
        self._in_body = False
        self._in_script_ldjson = False
        self._in_p = False
        self._current_p_parts = []
        self._skip_tag = None

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        tag_lower = tag.lower()

        if tag_lower == "title":
            self._in_title = True
        elif tag_lower in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._in_heading = tag_lower
        elif tag_lower == "body":
            self._in_body = True
        elif tag_lower == "p":
            self._in_p = True
            self._current_p_parts = []
        elif tag_lower == "meta":
            name = (attrs_dict.get("name") or "").lower()
            prop = (attrs_dict.get("property") or "").lower()
            content = attrs_dict.get("content") or ""
            if name == "description":
                self.meta_description = content
            elif prop == "og:title":
                self.og["og_title"] = content
            elif prop == "og:description":
                self.og["og_description"] = content
            elif prop == "og:image":
                self.og["og_image"] = content
        elif tag_lower == "link":
            rel = (attrs_dict.get("rel") or "").lower()
            href = attrs_dict.get("href") or ""
            if rel == "canonical":
                self.canonical = href
        elif tag_lower == "a":
            href = attrs_dict.get("href") or ""
            self.links.append(href)
        elif tag_lower == "img":
            alt = attrs_dict.get("alt")
            self.images.append({"has_alt": alt is not None and alt.strip() != ""})
        elif tag_lower == "script":
            script_type = (attrs_dict.get("type") or "").lower()
            if "application/ld+json" in script_type:
                self._in_script_ldjson = True
                self.has_ld_json = True
            else:
                self._skip_tag = "script"
        elif tag_lower == "style":
            self._skip_tag = "style"

    def handle_endtag(self, tag):
        tag_lower = tag.lower()
        if tag_lower == "title":
            self._in_title = False
        elif tag_lower in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._in_heading = None
        elif tag_lower == "p":
            if self._in_p:
                text = " ".join(self._current_p_parts).strip()
                if text:
                    self.paragraphs.append(text)
            self._in_p = False
            self._current_p_parts = []
        elif tag_lower == "script":
            self._in_script_ldjson = False
            self._skip_tag = None
        elif tag_lower == "style":
            self._skip_tag = None

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

# SEOParserFixed overrides handle_data with correct heading-append logic
class SEOParserFixed(SEOParser):
    def handle_data(self, data):
        if self._skip_tag:
            return
        cleaned = html_module.unescape(data)
        if self._in_title:
            self.title += cleaned
        if self._in_heading:
            existing = self.headings[self._in_heading]
            if existing:
                existing[-1] += cleaned
            else:
                existing.append(cleaned)
        if self._in_body and not self._in_script_ldjson:
            stripped = cleaned.strip()
            if stripped:
                self.body_text_parts.append(stripped)
                if self._in_p:
                    self._current_p_parts.append(stripped)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
STOPWORDS = {
    "a","an","the","and","or","but","in","on","at","to","for","of","with",
    "by","from","is","it","its","be","was","are","were","been","have","has",
    "had","do","does","did","will","would","could","should","may","might",
    "that","this","these","those","than","then","when","where","which","who",
    "what","how","not","no","as","up","out","if","so","we","you","he","she",
    "they","our","your","his","her","their","my","i","me","us","him","them",
}

def tokenize(text):
    return re.findall(r"[a-zA-Z0-9']+", text.lower())

def strip_stopwords(tokens):
    return [t for t in tokens if t not in STOPWORDS and len(t) >= 4]

def count_keyword(keyword, text):
    """Case-insensitive count of keyword occurrences in text."""
    kw = keyword.lower().strip()
    t = text.lower()
    if not kw:
        return 0
    count = 0
    start = 0
    while True:
        pos = t.find(kw, start)
        if pos == -1:
            break
        count += 1
        start = pos + 1
    return count

def categorize_links(links, source_url):
    internal = 0
    external = 0
    try:
        from urllib.parse import urlparse
        base = urlparse(source_url)
        base_netloc = base.netloc.lower().lstrip("www.")
    except Exception:
        base_netloc = ""

    for href in links:
        href = href.strip()
        if not href or href.startswith("#") or href.startswith("mailto:") or href.startswith("tel:"):
            continue
        if href.startswith("http://") or href.startswith("https://"):
            try:
                from urllib.parse import urlparse
                netloc = urlparse(href).netloc.lower().lstrip("www.")
                if base_netloc and netloc == base_netloc:
                    internal += 1
                else:
                    external += 1
            except Exception:
                external += 1
        else:
            # relative link = internal
            internal += 1
    return internal, external

def calc_seo_score(parser, keywords, source_url):
    score = 0
    body_text = " ".join(parser.body_text_parts)
    title = parser.title.strip()
    h1s = [h.strip() for h in parser.headings["h1"] if h.strip()]
    h1_text = " ".join(h1s).lower()

    # Title: 15 pts
    tlen = len(title)
    if title and 50 <= tlen <= 60:
        score += 15
    elif title and 30 <= tlen < 50:
        score += 8
    elif title and 60 < tlen <= 70:
        score += 8

    # Meta description: 15 pts
    mlen = len(parser.meta_description)
    if parser.meta_description and 150 <= mlen <= 160:
        score += 15
    elif parser.meta_description and 120 <= mlen < 150:
        score += 8
    elif parser.meta_description and 160 < mlen <= 175:
        score += 8

    # Exactly one H1: 15 pts
    if len(h1s) == 1:
        score += 15
    elif len(h1s) > 1:
        score += 5

    # Keywords in title: 10 pts (if keywords provided)
    # Keywords in H1: 10 pts (if keywords provided)
    # Keyword density 1-2.5%: 10 pts (if keywords provided)
    if keywords:
        kw_list = [k.strip().lower() for k in keywords.split(",") if k.strip()]
        total_words = len(tokenize(body_text))
        kw_in_title = any(count_keyword(kw, title) > 0 for kw in kw_list)
        kw_in_h1 = any(count_keyword(kw, h1_text) > 0 for kw in kw_list)
        if kw_in_title:
            score += 10
        if kw_in_h1:
            score += 10
        if total_words > 0:
            for kw in kw_list:
                cnt = count_keyword(kw, body_text)
                pct = (cnt / total_words) * 100
                if 1.0 <= pct <= 2.5:
                    score += 10
                    break

    # Internal links >= 3: 5 pts
    internal, external = categorize_links(parser.links, source_url)
    if internal >= 3:
        score += 5

    # Image alt coverage >= 80%: 5 pts
    total_imgs = len(parser.images)
    if total_imgs > 0:
        with_alt = sum(1 for img in parser.images if img["has_alt"])
        if (with_alt / total_imgs) >= 0.80:
            score += 5

    # Canonical URL: 5 pts
    if parser.canonical:
        score += 5

    # All 3 OG tags: 5 pts
    if all(k in parser.og for k in ("og_title", "og_description", "og_image")):
        score += 5

    # ld+json: 5 pts
    if parser.has_ld_json:
        score += 5

    return min(score, 100)

def build_warnings(parser, keywords, source_url):
    warnings = []
    title = parser.title.strip()
    tlen = len(title)

    if not title:
        warnings.append("title_missing: No <title> tag found")
    elif tlen < 30:
        warnings.append(f"title_too_short: Title is {tlen} chars (recommended 50–60)")
    elif tlen > 70:
        warnings.append(f"title_too_long: Title is {tlen} chars (recommended 50–60, search engines truncate above 60)")

    mlen = len(parser.meta_description)
    if not parser.meta_description:
        warnings.append("meta_description_missing: No meta description found")
    elif mlen < 120:
        warnings.append(f"meta_description_too_short: Meta description is {mlen} chars (recommended 150–160)")
    elif mlen > 175:
        warnings.append(f"meta_description_too_long: Meta description is {mlen} chars (recommended 150–160)")

    h1s = [h.strip() for h in parser.headings["h1"] if h.strip()]
    if len(h1s) == 0:
        warnings.append("h1_missing: No <h1> tag found")
    elif len(h1s) > 1:
        warnings.append(f"multiple_h1: {len(h1s)} H1 tags found (should be exactly 1)")

    if not parser.canonical:
        warnings.append("canonical_missing: No canonical URL set")

    og_missing = [k for k in ("og_title", "og_description", "og_image") if k not in parser.og]
    for k in og_missing:
        warnings.append(f"og_tag_missing: {k} not set")

    if not parser.has_ld_json:
        warnings.append("ld_json_missing: No ld+json structured data found")

    internal, _ = categorize_links(parser.links, source_url)
    if internal < 3:
        warnings.append(f"low_internal_links: Only {internal} internal link(s) found (recommended >= 3)")

    total_imgs = len(parser.images)
    if total_imgs > 0:
        with_alt = sum(1 for img in parser.images if img["has_alt"])
        pct = (with_alt / total_imgs) * 100
        if pct < 80:
            warnings.append(f"image_alt_coverage: {pct:.0f}% of images have alt text (recommended >= 80%)")

    if keywords:
        body_text = " ".join(parser.body_text_parts)
        total_words = len(tokenize(body_text))
        for kw in [k.strip().lower() for k in keywords.split(",") if k.strip()]:
            if total_words > 0:
                cnt = count_keyword(kw, body_text)
                pct = (cnt / total_words) * 100
                if pct > 3.0:
                    warnings.append(f"over_optimized: '{kw}' density {pct:.1f}% (>3%)")
                elif pct < 0.5:
                    warnings.append(f"under_optimized: '{kw}' density {pct:.1f}% (<0.5%)")
                elif pct > 2.5:
                    warnings.append(f"density_high: '{kw}' density {pct:.1f}% (borderline, monitor)")

    return warnings

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
html_file    = sys.argv[1]
source_label = sys.argv[2]
keywords     = sys.argv[3]   # "" if none
gap_input    = sys.argv[4]   # "" if none
meta_mode    = sys.argv[5] == "true"
compare_html = sys.argv[6]   # "" if none
compare_label = sys.argv[7]  # "" if none

try:
    with open(html_file, "r", encoding="utf-8", errors="replace") as fh:
        html_content = fh.read()
except Exception as e:
    print(json.dumps({"error": f"Failed to read HTML: {e}"}), file=sys.stderr)
    sys.exit(2)

try:
    parser = SEOParserFixed()
    parser.feed(html_content)
except Exception as e:
    print(json.dumps({"error": f"HTML parse error: {e}"}), file=sys.stderr)
    sys.exit(2)

body_text = " ".join(parser.body_text_parts)
total_words = len(tokenize(body_text))
title = parser.title.strip()
h1s = [h.strip() for h in parser.headings["h1"] if h.strip()]
internal, external = categorize_links(parser.links, source_label)
total_imgs = len(parser.images)
with_alt = sum(1 for img in parser.images if img["has_alt"])
img_coverage = round((with_alt / total_imgs) * 100, 1) if total_imgs > 0 else 0.0

# --- Keyword density ---
kw_density = {}
if keywords:
    first_para = parser.paragraphs[0] if parser.paragraphs else ""
    for kw in [k.strip().lower() for k in keywords.split(",") if k.strip()]:
        cnt = count_keyword(kw, body_text)
        pct = round((cnt / total_words) * 100, 2) if total_words > 0 else 0.0
        kw_density[kw] = {
            "count": cnt,
            "pct": pct,
            "in_title": count_keyword(kw, title) > 0,
            "in_h1": any(count_keyword(kw, h) > 0 for h in h1s),
            "in_first_paragraph": count_keyword(kw, first_para) > 0,
            "in_body": cnt > 0,
        }

# --- Content gap ---
content_gap = {}
if gap_input:
    # Determine if gap_input is a file path or inline keywords
    import os
    if os.path.isfile(gap_input):
        with open(gap_input, "r") as fh:
            gap_keywords = [line.strip() for line in fh if line.strip()]
    else:
        gap_keywords = [k.strip().lower() for k in gap_input.split(",") if k.strip()]

    missing = []
    underrepresented = []
    well_covered = []
    for kw in gap_keywords:
        cnt = count_keyword(kw, body_text)
        pct = (cnt / total_words) * 100 if total_words > 0 else 0.0
        if cnt == 0:
            missing.append(kw)
        elif pct < 0.5:
            underrepresented.append(kw)
        elif pct >= 1.0:
            well_covered.append(kw)
        else:
            underrepresented.append(kw)
    content_gap = {
        "missing": missing,
        "underrepresented": underrepresented,
        "well_covered": well_covered,
    }

# --- Meta validation ---
meta_validation = {}
if meta_mode:
    def check_length(value, lo_pass, hi_pass, lo_warn, hi_warn, absent_note):
        if not value:
            return {"status": "fail", "value": None, "note": absent_note}
        ln = len(value)
        if lo_pass <= ln <= hi_pass:
            return {"status": "pass", "value": ln, "note": None}
        elif ln < lo_warn or ln > hi_warn:
            return {"status": "fail", "value": ln, "note": f"Length {ln} chars is outside acceptable range ({lo_warn}–{hi_warn})"}
        else:
            return {"status": "warn", "value": ln, "note": f"Length {ln} chars (recommended {lo_pass}–{hi_pass})"}

    meta_validation["title_length"] = check_length(
        title, 50, 60, 30, 70,
        "No <title> tag — add one with primary keyword, 50–60 chars"
    )
    meta_validation["meta_description_length"] = check_length(
        parser.meta_description, 150, 160, 120, 175,
        "No meta description — add <meta name=\"description\" content=\"...\"> 150–160 chars"
    )
    for field, tag_hint in [
        ("canonical_url", "<link rel=\"canonical\" href=\"...\"> in <head>"),
        ("og_title",      "<meta property=\"og:title\" content=\"...\">"),
        ("og_description","<meta property=\"og:description\" content=\"...\">"),
        ("og_image",      "<meta property=\"og:image\" content=\"https://...1200x630.jpg\">"),
    ]:
        if field == "canonical_url":
            val = parser.canonical
        else:
            val = parser.og.get(field)
        if val:
            meta_validation[field] = {"status": "pass", "value": val, "note": None}
        else:
            meta_validation[field] = {"status": "fail", "value": None, "note": f"Missing — add {tag_hint}"}

    meta_validation["ld_json"] = {
        "status": "pass" if parser.has_ld_json else "fail",
        "value": parser.has_ld_json,
        "note": None if parser.has_ld_json else "No ld+json structured data — add Article, Product, or WebPage schema",
    }

# --- Competitor comparison ---
competitor_comparison = {}
if compare_html and compare_label:
    try:
        with open(compare_html, "r", encoding="utf-8", errors="replace") as fh:
            comp_html = fh.read()
        comp_parser = SEOParserFixed()
        comp_parser.feed(comp_html)

        comp_body = " ".join(comp_parser.body_text_parts)
        comp_words = len(tokenize(comp_body))

        def extract_keyword_profile(text, total):
            tokens = tokenize(text)
            clean = strip_stopwords(tokens)
            # Unigrams
            from collections import Counter
            uni = Counter(clean)
            # Bigrams
            bi = Counter()
            words = tokenize(text)
            for i in range(len(words) - 1):
                bg = f"{words[i]} {words[i+1]}"
                if len(words[i]) >= 4 and len(words[i+1]) >= 4 \
                        and words[i] not in STOPWORDS and words[i+1] not in STOPWORDS:
                    bi[bg] += 1
            profile = {}
            for kw, cnt in list(uni.items()) + list(bi.items()):
                if cnt >= 3:
                    pct = round((count_keyword(kw, text) / total) * 100, 2) if total > 0 else 0.0
                    profile[kw] = pct
            return profile

        target_profile = extract_keyword_profile(body_text, total_words)
        comp_profile = extract_keyword_profile(comp_body, comp_words)

        target_set = set(target_profile.keys())
        comp_set = set(comp_profile.keys())

        in_comp_only = sorted(comp_set - target_set)
        in_target_only = sorted(target_set - comp_set)
        in_both = {}
        for kw in sorted(target_set & comp_set):
            in_both[kw] = {
                "target_pct": target_profile[kw],
                "competitor_pct": comp_profile[kw],
            }

        competitor_comparison = {
            "target_url": source_label,
            "competitor_url": compare_label,
            "keywords_in_competitor_only": in_comp_only[:50],
            "keywords_in_target_only": in_target_only[:50],
            "keywords_in_both": dict(list(in_both.items())[:50]),
        }
    except Exception as e:
        competitor_comparison = {"error": f"Competitor parse error: {e}"}

# --- Score and warnings ---
seo_score = calc_seo_score(parser, keywords, source_label)
warnings = build_warnings(parser, keywords, source_label)

# --- Assemble output ---
result = {
    "url": source_label,
    "title_tag": {
        "text": title,
        "length": len(title),
        "keyword_present": any(
            count_keyword(kw.strip().lower(), title.lower()) > 0
            for kw in keywords.split(",") if kw.strip()
        ) if keywords else False,
    },
    "meta_description": {
        "text": parser.meta_description,
        "length": len(parser.meta_description),
    },
    "headings": {
        "h1_count": len([h for h in parser.headings["h1"] if h.strip()]),
        "h2_count": len([h for h in parser.headings["h2"] if h.strip()]),
        "h3_count": len([h for h in parser.headings["h3"] if h.strip()]),
        "h4_count": len([h for h in parser.headings["h4"] if h.strip()]),
        "h5_count": len([h for h in parser.headings["h5"] if h.strip()]),
        "h6_count": len([h for h in parser.headings["h6"] if h.strip()]),
        "h1_text": h1s,
    },
    "keyword_density": kw_density,
    "links": {
        "internal_count": internal,
        "external_count": external,
    },
    "images": {
        "total": total_imgs,
        "with_alt": with_alt,
        "coverage_pct": img_coverage,
    },
    "meta": {
        "canonical": parser.canonical,
        "og_title": parser.og.get("og_title"),
        "og_description": parser.og.get("og_description"),
        "og_image": parser.og.get("og_image"),
        "has_ld_json": parser.has_ld_json,
    },
    "seo_score": seo_score,
    "warnings": warnings,
}

if content_gap:
    result["content_gap"] = content_gap
if meta_validation:
    result["meta_validation"] = meta_validation
if competitor_comparison:
    result["competitor_comparison"] = competitor_comparison

print(json.dumps(result, indent=2))
PYEOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
TMPDIR_MAIN=$(_get_tmpdir)
HTML_FILE="${TMPDIR_MAIN}/target.html"

fetch_html "$TARGET" "$HTML_FILE"

COMPARE_HTML=""
COMPARE_LABEL=""
if [[ -n "$COMPARE_URL" ]]; then
    COMPARE_HTML="${TMPDIR_MAIN}/compare.html"
    fetch_html "$COMPARE_URL" "$COMPARE_HTML"
    COMPARE_LABEL="$COMPARE_URL"
fi

run_analysis \
    "$HTML_FILE" \
    "$TARGET" \
    "$KEYWORDS" \
    "$GAP_INPUT" \
    "$META_MODE" \
    "${COMPARE_HTML:-}" \
    "${COMPARE_LABEL:-}"
