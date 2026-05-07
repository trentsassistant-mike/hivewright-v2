---
name: web-research-verifier
description: Web research methodology — search-verify-cite workflow, source credibility, cross-referencing, anti-hallucination
metadata:
  openclaw:
    requires:
      bins: [curl, jq]
---

# Web Research Verifier Skill

Structured methodology for finding, evaluating, and citing web sources. Prevents hallucinated statistics, unverifiable claims, and low-credibility sourcing.

---

## 1. Search-Verify-Cite Workflow

Follow these steps in order for every research claim:

1. **Formulate query with date range.** Include a date range in your search (e.g., `after:2023-01-01`) to avoid outdated figures. For statistics, add the expected source type (e.g., `site:abs.gov.au` or `filetype:pdf`).
2. **Execute search.** Run the query. Collect the top 3–5 results before opening any of them.
3. **Evaluate credibility tier.** Before reading the content, classify the source domain against the tiers in Section 2. Discard Tier 3 sources if Tier 1 or 2 alternatives exist.
4. **Extract data with exact quote + URL + access date.** Copy the verbatim statistic or claim. Record the full URL and today's date as the access date. Do not paraphrase at this step.
5. **Cross-reference with ≥1 independent source.** Find at least one independent source (different domain, different publisher) that corroborates the claim. Use the checklist in Section 3.
6. **Format citation.** Write the citation using the block format in Section 5.

---

## 2. Source Credibility Tiers

### Tier 1 — Authoritative
Primary data producers. Prefer these above all others.

- Government statistical agencies: abs.gov.au, bls.gov, ons.gov.uk, stats.govt.nz
- Peer-reviewed databases: PubMed, JSTOR, Cochrane Library, SSRN
- Official regulatory filings: SEC EDGAR, ASX announcements, ASIC registers
- International bodies: WHO, World Bank, IMF, OECD, UN Statistics Division

### Tier 2 — Reliable
Reputable secondary sources. Acceptable when Tier 1 is unavailable.

- Wire services and quality mastheads: Reuters, AP, BBC, AFR, NYT, The Guardian
- Market research firms with named methodology: Gartner, IDC, Nielsen, Forrester, IBISWorld
- Professional associations with research arms: AMA, CPA Australia, Law Council of Australia
- Wikipedia articles with inline citations linking to Tier 1/2 sources (check citations, not just the Wikipedia article)

### Tier 3 — Caution
Use only for background context, never for quantitative claims.

- Blogs, personal websites, substack posts
- Forums and community sites (Reddit, Quora, Stack Overflow)
- Social media posts (LinkedIn articles, Twitter/X threads)
- Press releases from parties with a direct financial interest in the claim
- Undated content where the publication date cannot be determined

### Unacceptable
Do not cite under any circumstances.

- AI-generated content (ChatGPT responses, Claude outputs, Perplexity summaries)
- Content farms (see `scripts/verify-source.sh` for automated detection)
- Anonymous wikis without verifiable citations
- Paywalled content where you cannot verify the claim text directly

---

## 3. Cross-Reference Checklist

Run this checklist for every quantitative claim before including it in research output.

- [ ] **2+ independent sources confirm this figure.** Independent means different domains, different publishers, different research teams — not two articles citing the same original study.
- [ ] **Both sources are Tier 1 or Tier 2.** If one is Tier 3, escalate to find a Tier 1/2 replacement.
- [ ] **Sources agree on the figure.** If sources disagree, document both figures and the discrepancy — do not pick the one that fits your argument.
- [ ] **Data is fresh enough for the claim's context.** For market statistics: ≤2 years. For demographic data: ≤5 years (or most recent census). For scientific consensus: check review dates, not original study dates.
- [ ] **You are citing the primary source, not an aggregator.** If Source B says "according to Source A", cite Source A directly. Go upstream.
- [ ] **URL is accessible now.** Paste the URL in a browser. If it 404s or paywalls you out, you cannot verify it — mark as unverifiable and find an alternative.

---

## 4. Hallucination Red Flags

The following patterns in research output require mandatory cross-reference before use. If you cannot verify via cross-reference, discard the claim.

1. **Round numbers where precision is expected.** A statistic like "50% of hives" or "1 million users" is suspicious. Real survey data produces figures like 47.3% or 1,240,000.
2. **Statistics without a source URL in the same sentence or footnote.** Any quantitative claim lacking an inline citation is unverified by definition.
3. **Named reports that return zero search results.** If "The 2024 Global Workforce Productivity Report by McKinsey" returns no results, the report likely does not exist.
4. **Named organisations with no discoverable domain.** If "The Institute for Digital Commerce Research" has no website, it is not a verifiable source.
5. **Market share claims that sum to more than 100%.** This indicates multiple studies with different scopes being incorrectly merged.
6. **Very recent events with precise figures.** Statistics about events in the last 30 days rarely have verified aggregate data yet. Preliminary figures are frequently revised.
7. **Undated statistics in a fast-moving domain.** Technology adoption rates, social media usage, crypto prices — any stat without a clear date is effectively unverifiable.
8. **Exact dollar figures attributed to "industry sources."** If the attribution is vague, the figure is likely laundered from a secondary or tertiary source.

---

## 5. Citation Format

Use this block for every cited source in research output:

```
Source:         <Name of publication or organisation>
URL:            <Full URL>
Accessed:       <YYYY-MM-DD>
Published:      <YYYY-MM-DD or "undated">
Credibility:    Tier <1/2/3>
Freshness Note: <e.g., "2023 data — within 2-year threshold for market statistics">
```

**Example:**
```
Source:         Australian Bureau of Statistics — Labour Force, Australia
URL:            https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release
Accessed:       2024-03-15
Published:      2024-03-14
Credibility:    Tier 1
Freshness Note: Published yesterday — current
```

---

## 6. Using verify-source.sh

Run `scripts/verify-source.sh <URL>` to perform a quick automated credibility check on a URL before reading it.

```bash
scripts/verify-source.sh https://example.com/article
```

The script checks:
- Whether the URL uses HTTPS
- Whether the domain appears on a known content-farm list
- Domain registration age via `whois` (if available)

Output includes an `Assessment` field: `PROCEED-WITH-VERIFICATION` (no flags found) or `CAUTION-REQUIRED` (one or more flags triggered). A clean assessment does not guarantee the source is credible — apply the tier evaluation in Section 2 regardless.
