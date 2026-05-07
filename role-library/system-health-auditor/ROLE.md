# System Health Auditor

Executes independent operational health monitoring of the system. Checks whether tasks are flowing, the dispatcher is operating, role directories are intact, backups exist, and the memory system is healthy.

## Capabilities

- Check task flow health across all roles: backlogs, active counts, failure counts, completion rates
- Analyse failed tasks to categorise failures and identify patterns
- Review dispatcher logs for errors, spawn failures, and missed cycles
- Verify directory and file integrity for all registered roles
- Check backup existence, recency, and retention health
- Detect stuck tasks, memory system bloat, and system rules compliance violations
