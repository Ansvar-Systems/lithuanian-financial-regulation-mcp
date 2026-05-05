# Lithuanian Financial Regulation MCP

MCP server for LB (Bank of Lithuania) financial regulations

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-spec--compliant-green.svg)](https://modelcontextprotocol.io)

## What this is

This server indexes the materials listed under **Sources** below and exposes
them via the Model Context Protocol. Part of the Ansvar MCP fleet —
source-available servers published for self-hosting.

It makes no outbound network calls except to the upstream sources during
ingestion — no analytics, no phone-home.

## Why this exists

LLMs answering compliance, security, or legal questions from training data
alone will fabricate citations — confidently producing article numbers,
statute names, and source URLs that do not exist, or that do not say what
the model claims. This MCP exists so an agent can call a tool that returns
the real text, the real identifier, and the real source URL straight from
the indexed materials — and ground an answer rather than recall it.

One MCP, one corpus. The point is composition.

The **Ansvar Gateway** ([gateway.ansvar.eu](https://gateway.ansvar.eu))
joins this MCP with the rest of the Ansvar fleet behind a single
authenticated endpoint — 300+ servers covering legal jurisdictions, EU
regulations, security frameworks, sector regulators, privacy-pattern
catalogues, and risk-scoring tools. That lets an agent run cross-domain
workflows that no single MCP can serve alone:

- **Threat model and TARA.** Threat enumeration → known component
  vulnerabilities → severity scoring → applicable AI, cybersecurity, and
  automotive obligations → privacy threats. Every finding traceable to
  its source.
- **Gap analysis.** Target framework requirements → current-state
  evidence → unmet obligations → remediation guidance and authority
  opinions. Every gap traceable to the specific requirement that flagged
  it.
- **Data Protection Impact Assessment.** Privacy regulation articles →
  national DPA guidance → privacy-pattern catalogue → applicable case
  law.

### Getting high-quality citations

Citation accuracy degrades when an agent's context fills up. Long inputs
cause retrieval-stage drift — the model recalls claim text correctly but
misattributes the source. Two practices keep accuracy high:

1. **Focused first pass, checking-agent second pass.** Query a small,
   relevant set of MCPs first, then run a separate agent whose only job
   is to re-resolve each citation against the source MCP and flag any
   that no longer match. The checking agent uses the same MCP tools as
   the synthesis agent.
2. **Pull the source text verbatim when in doubt.** Every citation an
   agent emits points back to a tool call against this server. You — or
   another agent — can call the same tool with the same identifier and
   read the raw statute, article, or standard text directly. If the
   verbatim text doesn't support what the agent claimed, the citation
   was misused, regardless of whether the identifier was real.

Both patterns work the same way self-hosted or through the gateway.

## Two ways to use it

**Self-host (free, Apache 2.0)** — clone this repo, run the ingestion script to build your local database from the listed upstream sources, point your MCP client at the local server. Instructions below.

**Use the hosted gateway** — for production use against the curated,
kept-fresh corpus across the full Ansvar MCP fleet, with citation enrichment
and multi-jurisdiction fan-out — see [ansvar.eu](https://ansvar.eu).

## Self-hosting

### Install

> Requires Node 20+.

```bash
git clone https://github.com/Ansvar-Systems/lithuanian-financial-regulation-mcp.git
cd lithuanian-financial-regulation-mcp
npm install
```

### Build

```bash
npm run build
```

### Build the database

```bash
npm run ingest
```

The database lands at `./data/lb.db`.

Ingestion fetches from the upstream source(s) listed under **Sources** below and builds a local SQLite database. Re-run periodically to refresh. Review the source's published terms before running ingestion in a commercial deployment, and inspect the ingestion script in this repo for the actual access method (open API, bulk download, HTML scrape, or feed).

Ingestion is a snapshot — your local copy goes stale until you re-run it. The hosted gateway corpus is refreshed continuously.

### Configure your MCP client

```json
{
  "mcpServers": {
    "lithuanian-financial-regulation-mcp": {
      "command": "node",
      "args": ["dist/src/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `lt_fin_search_regulations` | Full-text search across Lietuvos bankas (Bank of Lithuania) regulatory provisions. |
| `lt_fin_get_regulation` | Get a specific Lietuvos bankas regulatory provision by sourcebook and reference. |
| `lt_fin_list_sourcebooks` | List all Lietuvos bankas regulatory sourcebooks with their names and descriptions. |
| `lt_fin_search_enforcement` | Search Lietuvos bankas enforcement actions — baudos (fines), sprendimai (decisions), and sanctions against financial institutions. |
| `lt_fin_check_currency` | Check whether a specific Lietuvos bankas regulatory provision reference is currently in force. |
| `lt_fin_about` | Return metadata about this MCP server: version, data source, tool list. |

## Sources

| Source | Source URL | Terms / license URL | License basis | Attribution required | Commercial use | Redistribution / caching | Notes |
|---|---|---|---|---|---|---|---|
| [Lietuvos bankas (Bank of Lithuania)](https://www.lb.lt/) | https://www.lb.lt/ | [Terms](https://www.lb.lt/) | Public domain — Lithuanian Copyright Act (Autorių teisių ir gretutinių teisių įstatymas) Art. 5(1) excludes legal acts and official documents from copyright; Lietuvos bankas does not publish a separate Creative Commons site licence | Yes | Conditional | Conditional | Lietuvos bankas (Bank of Lithuania) is a public authority. Underlying nutarimai (Board resolutions on licensing, AML/CFT, payment services), gairės (supervisory guidelines), rekomendacijos (recommendations), and poveikio priemonės (enforcement actions) are excluded from copyright under Lithuanian Copyright Act Art. 5(1) ('legal acts of the state, official documents of texts (decisions, judgments, ordinances), and their official translations'). The lb.lt site does not display a Creative Commons or open-data footer; the database compilation, search interface, and editorial commentary are subject to lb.lt reuse terms not expressly published. Note: lb.lt returns HTTP 403 to bot User-Agents — ingestion crawlers must use a browser-like UA header. Verify with Lietuvos bankas before commercial redistribution of the portal in its structured form. |

## What this repository does not provide

This repository's source — the MCP server code, schema, and ingestion script — is licensed under Apache
2.0. The license below covers the code in this repository only; it does not
extend to upstream materials. Pre-built database snapshots present under `data/` (e.g. `lb.db`), where shipped, are a convenience only. Their presence does not change the legal positioning above — running ingestion is still the canonical way to build a fresh corpus from upstream sources.

Running ingestion may download, cache, transform, and index materials from the listed upstream sources. You are responsible for confirming that your use of those materials complies with the source terms, attribution requirements, robots/rate limits, database rights, copyright rules, and any commercial-use or redistribution limits that apply in your jurisdiction.

## License

Apache 2.0 — see [LICENSE](LICENSE). Commercial use, modification, and
redistribution of **the source code in this repository** are permitted under
that license. The license does not extend to upstream materials downloaded by the ingestion script; those remain governed by their respective source terms listed above.

## The Ansvar gateway

If you'd rather not self-host, [ansvar.eu](https://ansvar.eu) provides this
MCP plus the full Ansvar fleet through a single authenticated endpoint, with
the curated production corpus, multi-MCP query orchestration, and citation
enrichment.

---

Issues: [github.com/Ansvar-Systems/lithuanian-financial-regulation-mcp/issues](https://github.com/Ansvar-Systems/lithuanian-financial-regulation-mcp/issues) · Security: <security@ansvar.eu>

