'use strict';
// ARC SEND GATE: every piece of code that moves VALUE out of an agent's wallet asks this gate first, with what it is about to
// sign. Caps live in ONE policy file the senders do not edit, and one log shows every decision. Runs on Arc mainnet at
// apexfaucet.xyz in front of every Arc/Base sender (2026-10-06).
//
//   const G = require('./src/send-gate.js');
//   const d = G.check({ source: 'gas-refill', chain: 'arc', chainId: 5042, from, to, usdc: 0.6 });
//   if (!d.allow) { ...do not sign... }
//
// Fails closed: a missing or unreadable policy, an unknown sender, a kill file, a wrong chain id, a wallet the sender is not
// registered for, a destination not on its list, a per-transaction or per-day cap exceeded, or a lock it cannot take = deny.
// Modes per sender (in the policy): enforce (a deny returns allow:false) or shadow (a deny is logged as would-deny and allowed,
// so a live job is never stopped by a gate nobody has watched yet; move to enforce after one clean cycle).
// The per-day total counts only ALLOWED sends, kept in the decisions log under a lock directory, so two processes cannot both
// spend the last of a day's cap. What it defends against: bugs in a sender. Not a stolen key (watch the chain for that), and
// not an attacker who can edit the policy: keep the policy file owned by another user than the one running the senders.
// Config: SEND_GATE_POLICY (default ./send-gate.json), SEND_GATE_DIR (default ./send-gate-data). See examples/send-gate.json.
const fs = require('fs');
const path = require('path');

const DIR = process.env.SEND_GATE_DIR || path.resolve('send-gate-data');
// Keep the policy where the senders' own user cannot write (we use a root-owned /etc/apex/send-gate.json).
const POLICY = process.env.SEND_GATE_POLICY || path.resolve('send-gate.json');
const LOG = path.join(DIR, 'log', 'decisions.ndjson');
const LOCK = path.join(DIR, 'log', '.lock');
const lc = (a) => String(a || '').toLowerCase();
const day = (t) => new Date(t).toISOString().slice(0, 10);

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(fn) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let i = 0; i < 100; i++) {   // up to ~10 s
    try { fs.mkdirSync(LOCK); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30000) { fs.rmdirSync(LOCK); continue; } } catch (_) {}   // a crashed holder
      sleepMs(100); continue;
    }
    try { return fn(); } finally { try { fs.rmdirSync(LOCK); } catch (_) {} }
  }
  throw new Error('send-gate lock busy for 10 s');
}
function readLog() {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function append(row) {
  const fresh = !fs.existsSync(LOG);
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
  if (fresh) { try { fs.chmodSync(LOG, 0o644); } catch (_) {} }
}

// Pure: the reasons a send breaks the policy (empty = allowed). Exported for the tests.
function reasons(policy, req, todayAllowedUsdc) {
  const r = [];
  if (!policy || typeof policy !== 'object' || !policy.senders) return ['policy missing or malformed'];
  if (policy.kill_file && fs.existsSync(policy.kill_file)) r.push('kill file present: ' + policy.kill_file);
  const s = policy.senders[req.source];
  if (!s) return r.concat(['unknown sender "' + req.source + '": add it to the policy first']);
  const chain = policy.chains && policy.chains[req.chain];
  if (!chain) r.push('chain ' + req.chain + ' not in the policy');
  else if (Number(req.chainId) !== Number(chain.id)) r.push('chain id ' + req.chainId + ' is not ' + req.chain + ' (' + chain.id + ')');
  if (!(s.wallets || []).map(lc).includes(lc(req.from))) r.push('wallet ' + req.from + ' is not registered for ' + req.source);
  // a sender may use the shared list only when its policy says so; otherwise only its own destinations
  const dest = Object.assign({}, s.global_destinations === true ? (policy.destinations || {}) : {}, s.destinations || {});
  // any_destination: for a sender whose payee comes from a seller's own 402 reply (an agent paying other agents),
  // a fixed list cannot exist; the per-payment and per-day caps carry the whole limit, so both must be small and set.
  if (s.any_destination === true) { if (!(Number(s.per_tx_usdc) <= 0.05)) r.push('any_destination needs a per-payment cap of at most 0.05 USDC'); }
  else if (!Object.keys(dest).map(lc).includes(lc(req.to))) r.push('destination ' + req.to + ' is not on the list');
  const usdc = Number(req.usdc);
  if (!(usdc >= 0)) r.push('amount missing or not a number');
  else {
    if (!(Number(s.per_tx_usdc) >= 0)) r.push('no per-transaction cap set for ' + req.source);
    else if (usdc > Number(s.per_tx_usdc)) r.push(usdc + ' USDC is over the per-transaction cap of ' + s.per_tx_usdc);
    if (!(Number(s.per_day_usdc) >= 0)) r.push('no per-day cap set for ' + req.source);
    else if (todayAllowedUsdc + usdc > Number(s.per_day_usdc)) r.push('today ' + todayAllowedUsdc + ' + ' + usdc + ' USDC is over the per-day cap of ' + s.per_day_usdc);
  }
  if (req.tokens && Object.keys(req.tokens).length) {
    const allowed = Object.keys(s.tokens || {}).map(lc);
    for (const [t, amt] of Object.entries(req.tokens)) {
      if (!allowed.includes(lc(t))) r.push('token ' + t + ' is not allowed for ' + req.source);
      else if (Number(amt) > Number(s.tokens[Object.keys(s.tokens).find((k) => lc(k) === lc(t))])) r.push('token ' + t + ': ' + amt + ' over its cap');
    }
  }
  return r;
}

// req: { source, chain, chainId, from, to, usdc, tokens?: { address: units }, purpose? }
// returns { allow, decision: 'allow'|'deny'|'would-deny', mode, reasons }
function check(req) {
  const at = new Date().toISOString();
  let policy = null, mode = 'enforce';
  try { policy = JSON.parse(fs.readFileSync(POLICY, 'utf8')); } catch (e) { policy = null; }
  if (policy && policy.senders && policy.senders[req.source] && policy.senders[req.source].mode === 'shadow') mode = 'shadow';
  try {
    return withLock(() => {
      const today = day(Date.now());
      const used = readLog().filter((d) => d.source === req.source && d.decision !== 'deny' && d.counted !== false && day(d.at) === today)
        .reduce((t, d) => t + (Number(d.usdc) || 0), 0);
      const why = reasons(policy, req, used);
      const decision = why.length ? (mode === 'shadow' ? 'would-deny' : 'deny') : 'allow';
      append({ at, source: req.source, chain: req.chain, from: lc(req.from), to: lc(req.to), usdc: Number(req.usdc), tokens: req.tokens || null, purpose: req.purpose || null, mode, decision, reasons: why });
      if (why.length) console.error('[send-gate] ' + decision.toUpperCase() + ' ' + req.source + ' ' + req.usdc + ' USDC -> ' + req.to + ': ' + why.join('; '));
      return { allow: decision !== 'deny', decision, mode, reasons: why };
    });
  } catch (e) {
    console.error('[send-gate] DENY (gate error, fail closed) ' + req.source + ': ' + e.message);
    try { append({ at, source: req.source, chain: req.chain, from: lc(req.from), to: lc(req.to), usdc: Number(req.usdc), mode, decision: mode === 'shadow' ? 'would-deny' : 'deny', reasons: ['gate error: ' + e.message] }); } catch (_) {}
    return { allow: mode === 'shadow', decision: mode === 'shadow' ? 'would-deny' : 'deny', mode, reasons: ['gate error: ' + e.message] };
  }
}

// After a send that the gate allowed did NOT happen (simulation failed, the caller gave up), give the amount back to the
// day's allowance: the caller records it so the cap counts only money that left.
function release(req, why) {
  try {
    withLock(() => {
      // never give back more than this sender actually took today for this destination
      const today = day(Date.now());
      const net = readLog().filter((d) => d.source === req.source && lc(d.to) === lc(req.to) && d.decision !== 'deny' && day(d.at) === today)
        .reduce((t, d) => t + (Number(d.usdc) || 0), 0);
      const back = Math.min(Math.abs(Number(req.usdc) || 0), Math.max(0, net));
      append({ at: new Date().toISOString(), source: req.source, chain: req.chain, from: lc(req.from), to: lc(req.to), usdc: -back, decision: 'release', reasons: [String(why || 'not sent')] });
    });
  }
  catch (e) { console.error('[send-gate] release not written: ' + e.message); }
}

module.exports = { check, release, reasons, DIR, POLICY, LOG };
