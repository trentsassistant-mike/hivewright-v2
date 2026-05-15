---
name: content-creation-toolkit
description: Templates, checklists, and automated quality checks for blog posts, email campaigns, landing pages, and brand voice consistency.
metadata:
  openclaw:
    requires:
      bins: [wc]
---

# Content Creation Toolkit

## Blog Post Template

### Hook Patterns
- **Question hook:** Open with a question that targets the reader's pain point
- **Statistic hook:** Lead with a surprising or compelling data point
- **Story hook:** Begin with a brief anecdote that illustrates the topic
- **Contrarian hook:** Challenge a common assumption in the industry

### Subheading Hierarchy
- H1: Post title (one per post)
- H2: Major sections (3-5 per post)
- H3: Subsections within H2 (2-3 per H2 max)
- Never skip levels (no H1 → H3)

### CTA Placement
- **Inline CTA:** After the first major section (soft, contextual)
- **Mid-post CTA:** At the halfway point (value exchange — download, subscribe)
- **End CTA:** Final paragraph (primary conversion action)

### SEO Keyword Integration
- Primary keyword in: title, first 100 words, one H2, meta description
- Secondary keywords: naturally in body text, 2-3 per 1000 words
- Avoid keyword stuffing — readability always wins

### Length Ranges
- Short-form: 600–800 words (news, updates)
- Standard: 1200–1800 words (how-to, opinion)
- Long-form: 2500–4000 words (pillar content, guides)

---

## Email Campaign Template

### Subject Line Formulas
- **How-to:** "How to [achieve outcome] in [timeframe]" — e.g., "How to double your open rates in 30 days"
- **Number:** "[Number] ways to [achieve outcome]" — e.g., "7 ways to reduce churn this quarter"
- **Question:** "[Pain point]?" — e.g., "Still struggling with cold outreach?"
- **Urgency:** "[Benefit] — [time constraint]" — e.g., "Free audit — this week only"
- **Curiosity gap:** "The [topic] mistake you're probably making" — e.g., "The onboarding mistake you're probably making"

### Preview Text
- Complement the subject line — don't repeat it
- 40–90 characters for mobile compatibility
- Include a reason to open: benefit, curiosity, or social proof

### Body Structure

**PAS (Problem–Agitate–Solve):**
1. **Problem:** State the reader's pain point clearly
2. **Agitate:** Amplify the consequences of inaction
3. **Solve:** Present your offering as the solution

**AIDA (Attention–Interest–Desire–Action):**
1. **Attention:** Bold opening line or striking fact
2. **Interest:** Explain why this matters to them specifically
3. **Desire:** Show the transformation or outcome
4. **Action:** Single, clear CTA

### CTA Patterns
- One primary CTA per email (button or bold link)
- Action verb + benefit: "Get your free audit," "Start saving today"
- Place above the fold for short emails; after the pitch for longer emails
- Repeat CTA at end if email exceeds 200 words

---

## Landing Page Copy Template

### HiveWright Product Copy Guard
When writing HiveWright landing pages, product pages, docs, onboarding copy, or sales collateral:
- Do **not** introduce "AI pilot", "Pilot AI", "pilot budget", "pilot mode", or "pilot program" unless the owner supplied that exact phrase as mandatory source copy.
- Prefer: "controlled autonomy", "governed autonomous operations", "AI spend budget", "Hive budget", "owner-facing outcome engine", and "human-on-loop governance".
- Before handoff, check changed customer-facing files for `/pilot/i`; remove the term unless it is explicitly owner-requested source language.

### Hero Section Structure
- **Headline:** Clear value proposition in 10 words or fewer
- **Subheadline:** Expand on the headline — who it's for and what they get
- **Hero CTA:** Primary action button with benefit-driven text
- **Social proof snippet:** One-line credibility (e.g., "Trusted by 500+ teams")

### Social Proof
- Customer testimonials with name, role, and company
- Logos of recognisable clients (with permission)
- Metrics: "X% improvement," "Y customers served"
- Third-party badges or certifications

### Feature-Benefit Mapping
For each feature:
| Feature | Benefit | Supporting detail |
|---------|---------|-------------------|
| What it does | Why the reader cares | Proof or specificity |

- Lead with the benefit, not the feature
- Maximum 4–6 features on a single landing page
- Use icons or visuals to break up feature blocks

### Objection Handling
Common objections to address on the page:
- **"Too expensive"** → ROI calculation or comparison
- **"Too complicated"** → Simplicity proof (setup time, demo)
- **"Will it work for me?"** → Segmented testimonials or case studies
- **"What if I don't like it?"** → Guarantee or free trial
- Place objection handling after features, before final CTA

---

## Brand Voice Checklist

Use this checklist to verify every piece of content matches brand voice:

- [ ] Tone matches brand guidelines (formal/casual/technical)?
- [ ] Jargon level is appropriate for target audience?
- [ ] First person vs. third person is consistent with brand style?
- [ ] Humour (if any) aligns with brand personality?
- [ ] Sentence length matches brand reading level?
- [ ] Banned words/phrases have been avoided?
- [ ] Value proposition language is consistent across all sections?
- [ ] CTA language matches brand action style?

---

## Self-Review Checklist

Before publishing, verify:

- [ ] Spelling and grammar checked?
- [ ] All links tested and working?
- [ ] Images have alt text?
- [ ] Meta description written (150–160 characters)?
- [ ] Mobile preview checked?
- [ ] Reading level appropriate for audience (aim for Grade 8–10)?
- [ ] No unsubstantiated claims without sources?
- [ ] CTA is clear and appears at least once?
- [ ] Content passes `scripts/content-check.sh` with no critical flags?
- [ ] Reviewed by a second person or the Brand Voice Checklist above?
