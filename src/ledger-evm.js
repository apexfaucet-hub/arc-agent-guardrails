'use strict';
// OUTFLOW RECORDER for Arc and Base. The sender calls it with the hash of a transaction IT signed; it reads the receipt and
// writes down the VALUE that left each named wallet (the network fee is not included). Runs on Arc mainnet at apexfaucet.xyz
// behind every sender, so the books can reconcile every balance change (2026-10-06).
//
// Rules:
// - Only the sender calls it, with its own hash. Never run it over a wallet's history (that would "explain" a drain).
// - Arc: every native USDC movement emits a Transfer log from 0xffff...fffe in 18 decimals; a transfer through the ERC-20 face
//   (0x3600...) also emits a 6-decimal mirror log, ignored here. Base: native ETH = tx.value; tokens from Transfer logs.
// - The sender states the most it meant to move (`expect`). Fails closed: an outflow above its bound, of an asset `expect` does
//   not name, an ERC-721/1155 transfer out of the wallet, or a token whose decimals() cannot be read => NOTHING is recorded and
//   the failure goes to <LEDGER_DIR>/_errors-<source>.ndjson. A contract that moved more than intended must never be explained
//   away by the chain it moved on.
// - It never throws into the caller's payment flow.
//
// expect: { usdc: max USDC, native: max ETH (Base), tokens: { <address>: max units } }
// Usage: await recordSentEvm(hash, { source: 'gas-refill', chain: 'arc', wallets: [from], expect: { usdc: 0.7 }, category: 'internal' })
// Config: LEDGER_DIR (default ./ledger).
const fs = require('fs');
const path = require('path');
const DIR = process.env.LEDGER_DIR || path.resolve('ledger');
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
function append(file, row) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(path.join(DIR, file), JSON.stringify(row, (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}
function fail(source, hash, why) {
  console.error('[ledger] NOT RECORDED ' + source + ' ' + String(hash).slice(0, 16) + ': ' + why);
  append('_errors-' + (SOURCE_RE.test(String(source || '')) ? source : 'unknown') + '.ndjson', { at: new Date().toISOString(), source, tx: hash, error: String(why).slice(0, 300) });
  return null;
}
const NATIVE_LOG = '0xfffffffffffffffffffffffffffffffffffffffe';   // Arc: native USDC Transfer logs, 18 decimals
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000';  // Arc: the ERC-20 face of the same USDC (mirror, ignored)
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// ERC-1155 TransferSingle / TransferBatch: topics [sig, operator, from, to]. Not valued here, so one out of our wallet fails closed.
const T1155 = ['0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'];
const RPCS = {
  arc: ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.beamrpc.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
};
const lc = (a) => String(a || '').toLowerCase();
const topicAddr = (t) => '0x' + String(t || '').slice(26).toLowerCase();

// Pure: the value that left `wallets` in one transaction. Exported for the tests.
// tx: { from, to, value (bigint) }; receipt: { status, logs: [{ address, topics, data }] }
// Returns { flows: [{ wallet, to, asset, raw (bigint), decimals|null, kind }], problems: [string] }
function evmOutflows(chain, tx, receipt, wallets) {
  const mine = new Set(wallets.map(lc));
  const flows = [], problems = [];
  if (chain === 'base' && mine.has(lc(tx.from)) && BigInt(tx.value || 0) > 0n) {
    flows.push({ wallet: lc(tx.from), to: lc(tx.to), asset: 'base:native', raw: BigInt(tx.value), decimals: 18, kind: 'native value' });
  }
  for (const l of receipt.logs || []) {
    const addr = lc(l.address);
    if (l.topics && T1155.includes(lc(l.topics[0])) && mine.has(topicAddr(l.topics[2]))) { problems.push('an ERC-1155 transfer left ' + topicAddr(l.topics[2]) + ' (token ' + addr + ')'); continue; }
    if (!l.topics || lc(l.topics[0]) !== TRANSFER) continue;
    if (chain === 'arc' && addr === ARC_USDC_ERC20) continue;   // mirror of the native log
    const from = topicAddr(l.topics[1]);
    if (!mine.has(from)) continue;
    if (l.topics.length === 4) { problems.push('an ERC-721 transfer left ' + from + ' (token ' + addr + ')'); continue; }
    if (l.topics.length !== 3) { problems.push('a Transfer log of unknown shape from ' + addr); continue; }
    const raw = BigInt(l.data);
    if (raw === 0n) continue;
    if (chain === 'arc' && addr === NATIVE_LOG) flows.push({ wallet: from, to: topicAddr(l.topics[2]), asset: 'arc:native', raw, decimals: 18, kind: 'usdc' });
    else if (chain === 'base' && addr === BASE_USDC) flows.push({ wallet: from, to: topicAddr(l.topics[2]), asset: 'base:' + BASE_USDC, raw, decimals: 6, kind: 'usdc' });
    else flows.push({ wallet: from, to: topicAddr(l.topics[2]), asset: chain + ':' + addr, raw, decimals: null, kind: 'token' });
  }
  return { flows, problems };
}

// Pure: compare flows with what the sender said it meant to move. Returns a list of problems (empty = within bounds).
function checkExpect(chain, flows, expect) {
  const problems = [];
  if (!expect || typeof expect !== 'object') return ['no expect given: refusing to record an unbounded outflow'];
  const sums = {};
  for (const f of flows) sums[f.asset] = (sums[f.asset] || 0) + Number(f.raw) / 10 ** f.decimals;
  for (const [asset, amt] of Object.entries(sums)) {
    let max = null;
    if (asset === 'arc:native' || asset === 'base:' + BASE_USDC) max = expect.usdc;
    else if (asset === 'base:native') max = expect.native;
    else { const t = asset.split(':')[1]; const k = Object.keys(expect.tokens || {}).find((x) => lc(x) === t); max = k ? expect.tokens[k] : undefined; }
    if (max == null || !(Number(max) >= 0)) problems.push('undeclared outflow: ' + amt + ' of ' + asset + ' left, and expect does not name it');
    else if (amt > Number(max) * (1 + 1e-9)) problems.push('exceeds-expectation: ' + amt + ' of ' + asset + ' left, the sender expected at most ' + max);
  }
  return problems;
}

async function client(chain, rpc) {
  const v = require('viem');
  const urls = rpc ? [rpc] : RPCS[chain];
  return { v, pub: v.createPublicClient({ transport: v.fallback(urls.map((u) => v.http(u, { timeout: 15000, retryCount: 1 })), { rank: false }) }) };
}

async function recordSentEvm(hash, meta) {
  const source = meta && meta.source;
  try {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(source || ''))) return fail(String(source), hash, 'bad source name');
    const chain = meta.chain;
    if (chain !== 'arc' && chain !== 'base') return fail(source, hash, 'chain must be arc or base');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || '')) || !Array.isArray(meta.wallets) || !meta.wallets.length) return fail(source, hash, 'missing hash or wallets');
    const { pub } = await client(chain, meta.rpc);
    let rc = null, tx = null;
    for (let i = 0; i < 18 && !rc; i++) {
      try { rc = await pub.getTransactionReceipt({ hash }); } catch (e) { /* not yet, or one node behind */ }
      if (!rc) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!rc) return fail(source, hash, 'receipt not found after 90 s (not landed, or RPC behind)');
    tx = await pub.getTransaction({ hash });
    if (rc.status !== 'success') { append(source + '.ndjson', { at: new Date().toISOString(), chain, tx: hash, failed: true, note: 'reverted on chain: only its fee left our wallet, which the reconciler counts itself' }); return []; }
    const { flows, problems } = evmOutflows(chain, tx, rc, meta.wallets);
    for (const f of flows) {
      if (f.decimals != null) continue;
      try { f.decimals = Number(await pub.readContract({ address: f.asset.split(':')[1], abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' })); }
      catch (e) { problems.push('decimals() unreadable for ' + f.asset + ': ' + (e.shortMessage || e.message).slice(0, 80)); }
    }
    if (problems.length) return fail(source, hash, problems.join('; '));
    const over = checkExpect(chain, flows, meta.expect);
    if (over.length) return fail(source, hash, over.join('; '));
    const blk = await pub.getBlock({ blockNumber: rc.blockNumber }).catch(() => null);
    const at = blk ? new Date(Number(blk.timestamp) * 1000).toISOString() : new Date().toISOString();
    flows.forEach((f, n) => append(source + '.ndjson', {
      at, chain, tx: hash, leg: n, wallet: f.wallet, direction: 'out', asset_id: f.asset,
      amount: Number(f.raw) / 10 ** f.decimals, amount_raw: f.raw.toString(), counterparty: f.to,
      category: meta.category || 'transfer', product: meta.product || null, notes: (meta.notes ? meta.notes + '; ' : '') + f.kind,
    }));
    return flows;
  } catch (e) { return fail(source, hash, 'recorder error: ' + (e && e.message)); }
}

module.exports = { recordSentEvm, evmOutflows, checkExpect, NATIVE_LOG, ARC_USDC_ERC20, BASE_USDC, DIR };
