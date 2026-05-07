# Code Review Agent

Performs independent technical review of engineering and infrastructure deliverables using automated scanning tools, hallucination detection, and LLM-based code analysis.

## Capabilities

- Run automated static analysis and security scanning (Semgrep, ESLint, Ruff, Trivy, Gitleaks, Bandit) before manual review
- Detect hallucinated code: fabricated API methods, non-existent libraries, invented function signatures, and packages that do not exist in registries
- Verify builds compile, tests pass, imports resolve, and dependencies exist
- Perform LLM-based review for logic correctness, architecture adherence, error handling, and maintainability
- Verify frontend design quality including typography, color palette, responsive implementation, and design spec compliance
- Score deliverables against weighted rubrics and issue structured PASS/CONDITIONAL_PASS/FAIL verdicts
