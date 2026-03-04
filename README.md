# graph-aave-mcp

<div align="center">

[![npm version](https://img.shields.io/npm/v/graph-aave-mcp)](https://www.npmjs.com/package/graph-aave-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-published-blue)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.PaulieB14/graph-aave-mcp)
[![smithery badge](https://smithery.ai/badge/paulieb14/graph-aave-mcp)](https://smithery.ai/servers/paulieb14/graph-aave-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<a href="https://glama.ai/mcp/servers/@PaulieB14/graph-aave-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@PaulieB14/graph-aave-mcp/badge" />
</a>

**MCP server for querying [AAVE](https://aave.com/) V2/V3 lending protocol and governance data via [The Graph](https://thegraph.com/) subgraphs.**

Exposes 14 tools and 5 guided prompts that any AI agent (Claude, Cursor, Copilot, etc.) can use to query lending markets, user positions, health factors, liquidations, flash loans, rate history, and AAVE governance — across **7 chains** (Ethereum, Base, Arbitrum, Polygon, Optimism, Avalanche, Fantom) via **11 subgraphs** covering both V2 and V3 deployments plus AAVE Governance V3.

</div>

> Published to the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.PaulieB14/graph-aave-mcp) as `io.github.PaulieB14/graph-aave-mcp`

## Supported Chains & Subgraphs

7 chains, 11 subgraphs — some chains have both V2 (legacy) and V3 deployments tracked separately.

| Chain | Version | Subgraph ID | 30-Day Queries |
|-------|---------|-------------|----------------|
| Ethereum | V3 | `Cd2gEDVeqnjBn1hSeqFMtw8Q1IiyV9FYUZkLNRcLB7g` | 21,600,000 |
| Base | V3 | `GQFbb95cE6d8mV989mL5figjqGaKCQB3xqYrr1bRyXqF` | 5,618,153 |
| Arbitrum | V3 | `DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B` | 5,600,000 |
| Polygon | V3 | `Co2URyXjnxaw8WqxKyVHdirq9Ahhmsvcts4dMedAq211` | 2,000,000 |
| Optimism | V3 | `DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb` | 1,800,000 |
| Ethereum | V3 (alt) | `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3GpiB1zk` | 1,300,000 |
| Avalanche | V3 | `2h9woxy8RTjHu1HJsCEnmzpPHFArU33avmUh4f71JpVn` | 1,200,000 |
| **Ethereum** | **Governance V3** | `A7QMszgomC9cnnfpAcqZVLr2DffvkGNfimD8iUSMiurK` | 486,000 |
| Polygon | V2 | `H1Et77RZh3XEf27vkAmJyzgCME2RSFLtDS2f4PPW6CGp` | 215,830 |
| Avalanche | V2 | `EZvK18pMhwlCjxwesRLTg81fP33WnR6BnZe5Cvma3H1C` | 133,000 |
| Fantom | V3 | `6L1vPqyE3xvkzkWJh6wUKc1ABWYYps5HJahoxhnv2PJn` | 13,240 |

## Prerequisites

You need a **free** Graph API key (takes ~2 minutes):

1. Go to [The Graph Studio](https://thegraph.com/studio/)
2. Connect your wallet (MetaMask, WalletConnect, etc.)
3. Click **"API Keys"** in the sidebar and create one
4. Free tier includes 100,000 queries/month

## Installation

```bash
npm install -g graph-aave-mcp
```

Or use directly with npx (no install needed):

```bash
GRAPH_API_KEY=your-key npx graph-aave-mcp
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Claude Code (CLI)

```bash
claude mcp add graph-aave -- npx -y graph-aave-mcp
```

Then set the environment variable:
```bash
export GRAPH_API_KEY=your-api-key-here
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

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

### Other MCP Clients

Use stdio transport with `npx graph-aave-mcp` as the command and `GRAPH_API_KEY` as an environment variable.

## Available Tools

### Discovery

| Tool | Description |
|------|-------------|
| `list_aave_chains` | List all supported AAVE chains with subgraph IDs, versions, and 30-day query volumes |
| `get_aave_schema` | Full GraphQL schema introspection for any chain's subgraph |

### Lending Markets

| Tool | Description |
|------|-------------|
| `get_aave_reserves` | All active lending markets on a chain — TVL, supply APY, borrow APY, LTV, liquidation thresholds |
| `get_aave_reserve` | Deep detail on one asset: lifetime stats, full config, token addresses |
| `get_reserve_rate_history` | Historical snapshots of APY, utilization rate, and TVL over time |

### User Positions

| Tool | Description |
|------|-------------|
| `get_aave_user_position` | Wallet's supplied assets, borrowed assets, collateral flags, and e-mode category |
| `simulate_health_factor` | Simulate how a price change affects a user's health factor — e.g. "ETH drops 20%" |

### Protocol Events

| Tool | Description |
|------|-------------|
| `get_recent_borrows` | Recent borrow events — filterable by user address or asset symbol |
| `get_recent_supplies` | Recent supply/deposit events (handles V2 `deposit` vs V3 `supply` automatically) |
| `get_aave_liquidations` | Recent liquidations — filterable by liquidated user or liquidator address |
| `get_aave_flash_loans` | Recent flash loans with amounts and fees paid |

### Governance

| Tool | Description |
|------|-------------|
| `get_governance_proposals` | AAVE Governance V3 proposals with titles, states, for/against vote counts |
| `get_proposal_votes` | Individual voter breakdown for a specific proposal by voting power |

### Advanced

| Tool | Description |
|------|-------------|
| `query_aave_subgraph` | Raw GraphQL escape hatch — execute any query against any chain |

## Guided Prompts

Prompts are pre-built multi-step workflows that guide any AI agent through common AAVE analysis tasks:

| Prompt | Description |
|--------|-------------|
| `analyze_aave_user` | Full wallet analysis: supplied/borrowed assets, health factor, liquidation risk |
| `aave_chain_overview` | Protocol overview for a chain: top markets, rates, recent activity |
| `compare_aave_rates` | Compare supply/borrow APY for one asset across all supported chains |
| `aave_liquidation_analysis` | Analyze liquidation patterns, top liquidators, and at-risk markets |
| `aave_governance_overview` | Recent governance proposals, voting results, and active decisions |

## Rate Conversion

AAVE stores interest rates in **RAY units** (27 decimal precision). To convert to human-readable APY:

```
Supply APY %  = liquidityRate    / 1e27 * 100
Borrow APY %  = variableBorrowRate / 1e27 * 100
```

Token amounts are stored in **native token units**. To convert:
```
Human amount = rawAmount / 10^decimals
```

## Health Factor

A user's health factor determines liquidation risk:

```
HF = Σ(collateral_i × price_i × liquidationThreshold_i) / Σ(debt_i × price_i)
```

- **HF > 1.0** — position is safe
- **HF = 1.0** — liquidation threshold reached
- **HF < 1.0** — position is liquidatable

Use `simulate_health_factor` to test how price movements affect a specific wallet's HF.

## Example Prompts for AI Agents

Once connected, an AI agent can answer questions like:

**Markets & Rates**
- *"What are the top AAVE markets on Ethereum by TVL?"*
- *"What is the current USDC supply APY on Base?"*
- *"Compare WETH borrow rates across all AAVE V3 chains"*
- *"Which chain has the cheapest stablecoin borrowing right now?"*

**User Positions**
- *"Analyze the AAVE position for wallet 0x..."*
- *"What is the health factor for address 0x... on Arbitrum?"*
- *"Show me what 0x... has supplied and borrowed on Polygon"*
- *"If ETH drops 30%, will address 0x... get liquidated?"*

**Protocol Activity**
- *"Show me the last 20 liquidations on Ethereum AAVE"*
- *"Who are the most active liquidators on Arbitrum this week?"*
- *"What are the biggest flash loans on Base recently?"*
- *"Show me recent USDC borrows on Optimism"*

**Governance**
- *"What are the latest AAVE governance proposals?"*
- *"Is there anything currently up for a vote in AAVE governance?"*
- *"Show me who voted on proposal #185 and how"*
- *"What governance proposals have passed recently?"*

## Development

```bash
git clone https://github.com/PaulieB14/graph-aave-mcp.git
cd graph-aave-mcp
npm install
npm run build
GRAPH_API_KEY=your-key node build/index.js
```

To test with a specific chain:
```bash
# Start the server and query it with a GraphQL client or MCP inspector
GRAPH_API_KEY=your-key npx @modelcontextprotocol/inspector node build/index.js
```

## Schema Notes

**Lending subgraphs (V3)** use AAVE-native schema:
- `reserves` — individual asset markets
- `userReserves` — user positions per asset
- `borrows`, `supplies`, `repays` — transaction events
- `liquidationCalls` — liquidation events
- `flashLoans` — flash loan events
- `reserveParamsHistoryItems` — historical rate snapshots

**Lending subgraphs (V2)** use the same schema but with `deposits` instead of `supplies`.

**Governance subgraph** uses a separate schema:
- `proposals` — governance proposals with votes and payloads
- `proposalVotes_collection` — individual voter records
- `proposalMetadata_collection` — proposal titles and content
- `payloads` — on-chain execution payloads
- `votingPortals`, `votingConfigs` — governance configuration

## License

MIT
