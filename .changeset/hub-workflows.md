---
"@truefoundry/trueforge": patch
"@truefoundry/trueforge-ui": patch
"@truefoundry/trueforge-assistant-ui-runtime": patch
---

Add Home and workflows. Home is the entry point to two spaces, Agents and Workflows, each with its own sidebar menu, and helps people choose between them, with an advisor chat that recommends an agent or a workflow and drafts it. Workflows run a graph of steps (HTTP, edit fields, if, switch, merge, wait, stop and error, filter, sort, limit, remove duplicates, split out, aggregate, date and time, crypto, and agent) from one or more manual, cron, or webhook triggers, with a visual editor, an n8n-style step picker, import and export in Forgeflow or n8n JSON, and per-step run history.
