# graph-aave-mcp

<div align="center">

[![npm version](https://img.shields.io/npm/v/graph-aave-mcp)](https://www.npmjs.com/package/graph-aave-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-published-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.PaulieB14/graph-aave-mcp)
[![smithery badge](https://smithery.ai/badge/paulieb14/graph-aave-mcp)](https://smithery.ai/servers/paulieb14/graph-aave-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<a href="https://glama.ai/mcp/servers/@PaulieB14/graph-aave-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@PaulieB14/graph-aave-mcp/badge" />
</a>

**MCP server for [AAVE](https://aave.com/) V2, V3, and V4 — 32 tools across 11 Graph subgraphs + the Aave V4 API.**

Covers lending markets, user positions, health factors, liquidations, flash loans, governance, V4 hubs/spokes, exchange rates, swap quotes, rewards, and protocol history.

</div>

> Published to the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.PaulieB14/graph-aave-mcp) as `io.github.PaulieB14/graph-aave-mcp`

## Two Data Sources

| Source | Version | What it provides | Auth |
|--------|---------|------------------|------|
| **The Graph subgraphs** | V2/V3 | 11 subgraphs across 7 chains — reserves, positions, events, governance | `GRAPH_API_KEY` (free) |
| **Aave V4 API** | V4 | Hubs, spokes, reserves, exchange rates, user positions, activities, swap quotes, rewards | None needed |

## Quick Start

```bash
# Claude Code
claude mcp add graph-aave -- npx -y graph-aave-mcp

# Set Graph API key for V2/V3 tools (V4 tools work without it)
export GRAPH_API_KEY=your-key-here
```

<details>
<summary>Claude Desktop / Cursor config</summary>

```json
{
  "mcpServers": {
    "graph-aave": {
      "command": "npx",
      "args": ["-y", "graph-aave-mcp"],
      "env": {
        "GRAPH_API_KEY": "your-api-key-here"
      }
    }
  }
}
```
</details>

Free Graph API key: [thegraph.com/studio](https://thegraph.com/studio/) (100K queries/month free tier).

**Hosted deployment** (no install): [Fronteir AI](https://fronteir.ai/mcp/paulieb14-graph-aave-mcp)

---

## V2/V3 Tools (The Graph Subgraphs)

15 tools + 1 raw query escape hatch. Requires `GRAPH_API_KEY`.

### Discovery

| Tool | Description |
|------|-------------|
| `list_aave_chains` | All supported chains with subgraph IDs, versions, 30d query volumes |
| `get_aave_schema` | Full GraphQL schema introspection for any chain |

### Lending Markets

| Tool | Description |
|------|-------------|
| `get_aave_reserves` | All active markets — TVL, supply/borrow APY, LTV, liquidation thresholds |
| `get_aave_reserve` | Deep detail on one asset: lifetime stats, config, token addresses |
| `get_reserve_rate_history` | Historical APY, utilization, TVL snapshots |

### User Positions

| Tool | Description |
|------|-------------|
| `get_aave_user_position` | Wallet's supplied/borrowed assets, collateral flags, e-mode |
| `simulate_health_factor` | Simulate price changes on a user's health factor |

### Protocol Events

| Tool | Description |
|------|-------------|
| `get_recent_borrows` | Recent borrows — filter by user or asset |
| `get_recent_supplies` | Recent supplies/deposits (auto-handles V2 vs V3 schema) |
| `get_aave_repays` | Recent repayments |
| `get_aave_liquidations` | Recent liquidations — filter by user or liquidator |
| `get_aave_flash_loans` | Recent flash loans with fees |

### Governance

| Tool | Description |
|------|-------------|
| `get_governance_proposals` | Proposals with titles, states, vote counts |
| `get_proposal_votes` | Per-voter breakdown by voting power |

### Advanced

| Tool | Description |
|------|-------------|
| `query_aave_subgraph` | Raw GraphQL — execute any query against any chain |

### Supported Chains (V2/V3)

| Chain | Version | 30d Queries |
|-------|---------|-------------|
| Ethereum | V3 | 21.6M |
| Base | V3 | 5.6M |
| Arbitrum | V3 | 5.6M |
| Polygon | V3 | 2.0M |
| Optimism | V3 | 1.8M |
| Avalanche | V3 | 1.2M |
| Ethereum | V2 | 701K |
| Polygon | V2 | 216K |
| Avalanche | V2 | 133K |
| Fantom | V3 (Messari) | 13K |
| Ethereum | Governance V3 | 486K |

---

## V4 Tools (Aave API)

16 tools powered by `api.aave.com/graphql`. **No API key needed.**

### Liquidity Model

| Tool | Description |
|------|-------------|
| `get_v4_hubs` | Liquidity hubs (Core, Plus, Prime) with TVL and utilization |
| `get_v4_spokes` | Cross-chain spokes (Main, Bluechip, Kelp, Lido, Ethena, EtherFi, Forex, Gold, Lombard) |
| `get_v4_reserves` | Per-spoke reserves with supply/borrow APYs, risk params, caps |
| `get_v4_chains` | Supported V4 chains |
| `get_v4_asset` | Cross-hub asset summary with average APYs and price |
| `get_v4_exchange_rate` | Any token price via Chainlink oracles (ERC-20, native, or fiat) |
| `get_v4_asset_price_history` | Historical token prices |
| `get_v4_protocol_history` | Total deposits/borrows over time |

### User Data

| Tool | Description |
|------|-------------|
| `get_v4_user_positions` | Cross-chain positions — health factor, collateral, debt, borrowing power |
| `get_v4_user_summary` | Aggregated portfolio: total positions, net balance, net APY |
| `get_v4_user_supplies` | Supply positions with principal and interest |
| `get_v4_user_borrows` | Borrow positions with debt breakdown |
| `get_v4_user_balances` | Cross-chain token holdings with best APYs per token |
| `get_v4_user_activities` | Transaction history: supplies, borrows, repays, liquidations, swaps |
| `get_v4_claimable_rewards` | Claimable Merkl and points rewards |
| `get_v4_swap_quote` | Read-only swap pricing via CoW Protocol (MEV-protected) |

### V4 Architecture

```
Hubs (Core, Plus, Prime)
  └── Assets (WETH, USDC, GHO, cbBTC, etc.)
       └── Spokes (Main, Bluechip, Kelp, Lido, Ethena, ...)
            └── Reserves (per-spoke lending markets)
                 └── User Positions (health factor, collateral, debt)
```

V4 enables cross-chain lending: supply on one spoke, borrow on another. Hubs aggregate liquidity across spokes.

---

## Guided Prompts

6 pre-built workflows that guide agents through multi-step analysis:

| Prompt | Description |
|--------|-------------|
| `analyze_aave_user` | Full wallet analysis: positions, health factor, liquidation risk |
| `aave_chain_overview` | Protocol overview: top markets, rates, recent activity |
| `compare_aave_rates` | Compare APY for one asset across all chains |
| `aave_liquidation_analysis` | Liquidation patterns, top liquidators, at-risk markets |
| `aave_governance_overview` | Recent proposals, voting results, active decisions |
| `aave_full_stack_analysis` | Cross-version comparison: V2 vs V3 vs V4 rates and positions |

---

## Example Questions

**V4 (new):**
- *"What are the Aave V4 hubs and their utilization?"*
- *"Show me V4 reserves with the highest supply APY"*
- *"What's the current ETH price on Aave V4?"*
- *"Compare V3 vs V4 USDC supply rates"*
- *"What spokes does Aave V4 have on Ethereum?"*

**V2/V3:**
- *"What are the top AAVE markets on Ethereum by TVL?"*
- *"Compare WETH borrow rates across all V3 chains"*
- *"Analyze the AAVE position for wallet 0x..."*
- *"If ETH drops 30%, will address 0x... get liquidated?"*
- *"Show me the last 20 liquidations on Ethereum"*
- *"What AAVE governance proposals are active?"*

## Development

```bash
git clone https://github.com/PaulieB14/graph-aave-mcp.git
cd graph-aave-mcp
npm install
npm run build
GRAPH_API_KEY=your-key node build/index.js
```

## License

MIT
