# arc-agent-guardrails

Small, dependency-light building blocks for AI agents that move money on **Arc** (and Base). They run in production in front of
every sender at [apexfaucet.xyz](https://apexfaucet.xyz/arc/) (agent #1 in Arc's ERC-8004 registry). Plain Node.js + viem.

| file | what it gives you |
|---|---|
| `src/send-gate.js` | A **fail-closed policy gate** in front of an agent's key. Per sender: allowed wallets, allowed destinations, per-send and per-day USDC caps, token caps, shadow or enforce mode, a kill file. Missing policy, unknown sender, wrong chain id, a lock it cannot take: **deny**. |
| `src/ledger-evm.js` | An **outflow recorder**: after a send, read the receipt and write down the value that left each wallet (Arc native USDC logs, Base ETH/USDC, any ERC-20). The sender states what it meant to move; anything more, anything undeclared, or an NFT leaving the wallet is **not recorded** and logged as an error, so your books alarm instead of "explaining" a drain. |
| `src/vault-exit.js` | **Exit liquidity for Morpho Vault V2 on Arc**: how much a depositor can withdraw *at this block* (idle USDC + free supply of the market the vault's withdraw path draws from), read on chain from Morpho Blue. Circle Earn Kit names the vaults (optional dependency). |
| `src/agent-score.js` | A published 0-100 **agent score rubric** (`apex-watch-v1`) built only from measured facts: registration file, endpoints, uptime over measured hours, Arc payment offer verified, domain verified, speed, outside payers. Points only for what was verified. |
| `browser/erc4626-own-wallet.js` | **Deposit/withdraw from the user's own wallet** into an ERC-4626 vault: exact approve, receiver locked to the connected wallet and re-checked before every send, deposits above the vault's current exit liquidity refused, every call simulated first. |
| `browser/erc8004-rate.js` | A **"Rate on Arc" box**: any visitor rates any ERC-8004 agent from their own wallet; the live score is read from the registry in the browser; your own wallets can be refused (hashed list). |

## Send gate in 30 seconds

```js
process.env.SEND_GATE_POLICY = '/etc/myagent/send-gate.json';   // keep it owned by another user than the agent
const G = require('./src/send-gate.js');
const req = { source: 'gas-refill', chain: 'arc', chainId: 5042, from, to, usdc: 0.6, purpose: 'operator gas' };
const d = G.check(req);
if (!d.allow) throw new Error('refused: ' + d.reasons.join('; '));
// ...sign and send...; if nothing was broadcast: G.release(req, 'why')
```

Policy: see [`examples/send-gate.json`](examples/send-gate.json). Every decision (allow, deny, would-deny, release) is appended to
`<SEND_GATE_DIR>/log/decisions.ndjson`; the day's total counts only allowed sends.

**What it defends against:** bugs in your own senders (a wrong amount, a wrong address, a loop). **Not** a stolen key: watch the
chain for that. **Not** an attacker who can edit the policy: keep the policy file owned by another user than the agent's.

## Outflow recorder

```js
const { recordSentEvm } = require('./src/ledger-evm.js');
await recordSentEvm(hash, { source: 'gas-refill', chain: 'arc', wallets: [from], expect: { usdc: 0.6 }, category: 'internal' });
```

## Tests

`npm install && npm test`: the gate's planted faults (over the day cap, unknown destination, wrong chain id, unregistered wallet,
unknown sender, kill file, unreadable policy), the recorder's refusals, the browser encoders checked byte for byte against viem,
and the score rubric. Break a rule in `src/send-gate.js` and a test fails: that is how we check the checks.

The send gate guards OUR keys on our server. Its on-chain sibling for anyone is
[arc-mandate](https://github.com/apexfaucet-hub/arc-mandate): a spending box on Arc whose contract enforces per-payment, per-day,
payee and end-date limits on every payment an agent makes, by standard x402 (EIP-1271) or directly, with no admin and no fee.

Part of the APEX Faucet treasury operator ([apex-treasury-operator](https://github.com/apexfaucet-hub/apex-treasury-operator)).
MIT licensed.
