// Tests with planted faults. Run: npm test   (needs viem; no network except none: everything here is offline)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { encodeFunctionData, parseAbi } = require('viem');
let bad = 0; const ok = (name, cond) => { if (!cond) bad++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };

// 1. send gate: a normal send passes, every planted fault is refused, the day cap counts only allowed sends
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
process.env.SEND_GATE_DIR = tmp; process.env.SEND_GATE_POLICY = path.join(tmp, 'policy.json');
const W = '0x1111111111111111111111111111111111111111', D = '0x2222222222222222222222222222222222222222';
fs.writeFileSync(process.env.SEND_GATE_POLICY, JSON.stringify({ kill_file: path.join(tmp, 'STOP'), chains: { arc: { id: 5042 } },
  senders: { refill: { mode: 'enforce', wallets: [W], destinations: { [D]: 'gas' }, per_tx_usdc: 1, per_day_usdc: 1.5 },
             shadowed: { mode: 'shadow', wallets: [W], destinations: { [D]: 'gas' }, per_tx_usdc: 0.1, per_day_usdc: 1 } } }));
const G = require('../src/send-gate.js');
const base = { source: 'refill', chain: 'arc', chainId: 5042, from: W, to: D, usdc: 0.8 };
ok('gate: a normal send is allowed', G.check(base).allow === true);
ok('gate: planted second send over the day cap is refused', G.check(base).allow === false);
ok('gate: planted unknown destination is refused', G.check({ ...base, usdc: 0.1, to: '0x9999999999999999999999999999999999999999' }).allow === false);
ok('gate: planted wrong chain id is refused', G.check({ ...base, usdc: 0.1, chainId: 8453 }).allow === false);
ok('gate: planted wallet not registered is refused', G.check({ ...base, usdc: 0.1, from: '0x8888888888888888888888888888888888888888' }).allow === false);
ok('gate: planted unknown sender is refused', G.check({ ...base, source: 'nobody', usdc: 0.1 }).allow === false);
ok('gate: shadow mode logs would-deny but allows', G.check({ ...base, source: 'shadowed', usdc: 5 }).decision === 'would-deny');
fs.writeFileSync(path.join(tmp, 'STOP'), 'stop');
ok('gate: planted kill file refuses everything', G.check({ ...base, usdc: 0.01 }).allow === false);
fs.unlinkSync(path.join(tmp, 'STOP'));
fs.writeFileSync(process.env.SEND_GATE_POLICY, '{ broken');
ok('gate: planted unreadable policy fails closed', G.check({ ...base, usdc: 0.01 }).allow === false);

// 2. outflow recorder: pure functions on synthetic receipts
const L = require('../src/ledger-evm.js');
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const log = (addr, from, to, raw) => ({ address: addr, topics: [T, pad(from), pad(to)], data: '0x' + BigInt(raw).toString(16) });
const r1 = { logs: [log(L.NATIVE_LOG, W, D, 10n ** 18n), log(L.ARC_USDC_ERC20, W, D, 10n ** 6n)] };
const f1 = L.evmOutflows('arc', { from: W, to: D, value: 0n }, r1, [W]);
ok('recorder: 1 USDC native counted once (the ERC-20 mirror ignored)', f1.flows.length === 1 && f1.flows[0].raw === 10n ** 18n);
ok('recorder: within expect passes', L.checkExpect('arc', f1.flows, { usdc: 1 }).length === 0);
ok('recorder: planted outflow over expect is refused', L.checkExpect('arc', f1.flows, { usdc: 0.5 }).length === 1);
ok('recorder: planted missing expect is refused', L.checkExpect('arc', f1.flows, null).length === 1);
const nft = { logs: [{ address: '0x7777777777777777777777777777777777777777', topics: [T, pad(W), pad(D), pad('0x01')], data: '0x' }] };
ok('recorder: planted ERC-721 leaving the wallet is a problem', L.evmOutflows('arc', { from: W, to: D, value: 0n }, nft, [W]).problems.length === 1);

// 3. browser encoders equal viem's
global.window = { EARN_VAULTS: [], EARN_ON: false }; global.document = { getElementById: () => null, addEventListener() {}, readyState: 'complete', querySelectorAll: () => [], head: { appendChild() {} }, createElement: () => ({}) };
eval(fs.readFileSync(path.join(__dirname, '../browser/erc4626-own-wallet.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '../browser/erc8004-rate.js'), 'utf8'));
const E = window.ApexEarn.ENC, abi = parseAbi(['function approve(address,uint256)', 'function deposit(uint256,address)', 'function redeem(uint256,address,address)', 'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)']);
ok('encoder: approve', E.approve(D, 5n) === encodeFunctionData({ abi, functionName: 'approve', args: [D, 5n] }));
ok('encoder: deposit to self', E.deposit(123n, W) === encodeFunctionData({ abi, functionName: 'deposit', args: [123n, W] }));
ok('encoder: redeem to self', E.redeem(10n ** 18n, W, W) === encodeFunctionData({ abi, functionName: 'redeem', args: [10n ** 18n, W, W] }));
ok('encoder: ERC-8004 giveFeedback', window.ApexRate.encGive(7, 80, 'quality', 'example.org') === encodeFunctionData({ abi, functionName: 'giveFeedback', args: [7n, 80n, 0, 'quality', 'example.org', '', '', '0x' + '0'.repeat(64)] }));
ok('parser: refuses 1.1234567 and 1e3', window.ApexEarn.toUnits('1.1234567') === null && window.ApexEarn.toUnits('1e3') === null);

// 4. agent score rubric
const S = require('../src/agent-score.js');
ok('score: a measured, payable, verified, fast agent with outside payers scores 100', S.score({ status: 'up', file: { has: true }, samples7d: 48, uptime7d: 100, arcPayable: { signable: true }, domains: [{ verified: true }], p50Ms: 200 }, { distinctPayers: 5, topPayerShare: 0.3 }).score === 100);
ok('score: an unchecked agent is partial', S.score({ status: 'unchecked', file: { has: true }, samples7d: 0 }).partial === true);
console.log(bad ? bad + ' FAILED' : 'all passed'); process.exit(bad ? 1 : 0);
