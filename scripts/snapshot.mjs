#!/usr/bin/env node
// Builds data/snapshot.json for Swarm Ledger.
//
// api.imd.fun sends no CORS headers, so a browser page on another origin cannot read
// it directly. This script runs on a schedule (GitHub Actions), reads the public API,
// adds claim status straight from each distributor contract, and writes one static
// JSON file the page loads. Read-only: it never signs or sends a transaction.
//
// Node 22+, no dependencies.  Usage: node scripts/snapshot.mjs [out.json]

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const API = "https://api.imd.fun";
const OUT = process.argv[2] ?? "data/snapshot.json";
const RPC = {
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  11155111: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
};
const EXPLORER = { 1: "https://etherscan.io", 11155111: "https://sepolia.etherscan.io" };
// IMD reward distributor on mainnet (POOL4 docs §11): holds the NFT-node reserve.
const REWARD_DISTRIBUTOR = "0x9046739E1535B40EfBe6AB3f45d0024b690eCA30";
// Operator payouts: the developer's wallet (surfsurf.eth, which also owns the POOL4
// hooks) sends IMD to every seat that ran the daemon, in one Disperse call per round.
const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const PAYOUT_SENDER = "0x047f606fd5b2baa5f5c6c4ab8958e45cb6b054b7";
const DISPERSE = "0xd15fe25ed0dba12fe05e7029c88b10c25e8880e3";
const PAYOUTS_SINCE = "2026-09-20T00:00:00Z"; // the swarm went live on 21 Sep
const BLOCKSCOUT = "https://eth.blockscout.com/api/v2";

const SEL = {
  claimed: "0x120aa877", // claimed(uint256,address)
  roundOf: "0xc7c38091", // roundOf(uint256) -> (root, funded, claimed, unlocksAt)
  openedAt: "0x07f9f760", // openedAt(uint256)
  sweepDelay: "0x80d9adca", // sweepDelay()
  heldNft: "0x8d9f2fff", // heldNft()
  nftEarned: "0x4c110e71", // nftEarned()
};

const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const addrWord = (a) => word(a.toLowerCase());
const u256 = (hex, i = 0) => BigInt("0x" + (hex.replace(/^0x/, "").slice(i * 64, i * 64 + 64) || "0"));

async function getJson(path, attempt = 0) {
  try {
    const r = await fetch(API + path, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "swarm-ledger" } });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt < 2) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); return getJson(path, attempt + 1); }
    throw e;
  }
}

// JSON-RPC batch eth_call with endpoint fallback; returns results in request order (null on error).
async function ethCalls(chainId, calls) {
  const out = new Array(calls.length).fill(null);
  for (let start = 0; start < calls.length; start += 40) {
    const chunk = calls.slice(start, start + 40);
    const body = chunk.map((c, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] }));
    let done = false;
    for (const url of RPC[chainId] ?? []) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        const res = await r.json();
        if (!Array.isArray(res)) throw new Error("not a batch response");
        for (const x of res) if (typeof x.result === "string" && x.result !== "0x") out[start + x.id] = x.result;
        done = true;
        break;
      } catch { /* try the next endpoint */ }
    }
    if (!done) console.warn(`rpc ${chainId}: a batch failed on every endpoint`);
  }
  return out;
}

async function blockscout(path, attempt = 0) {
  try {
    const r = await fetch(BLOCKSCOUT + path, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "swarm-ledger" } });
    if (!r.ok) throw new Error(`blockscout ${path}: HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt < 2) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); return blockscout(path, attempt + 1); }
    throw e;
  }
}

// Every IMD Disperse round from the payout wallet since PAYOUTS_SINCE, newest first.
// A recipient appears once per seat in some rounds and once per wallet (summed) in
// others, so amounts are summed per wallet and seats = amount / per-seat amount.
async function readPayouts() {
  const found = [];
  let query = "?filter=from";
  for (let page = 0; page < 20; page++) {
    const res = await blockscout(`/addresses/${PAYOUT_SENDER}/transactions${query}`);
    const items = res.items ?? [];
    for (const t of items) {
      if (t.to?.hash?.toLowerCase() === DISPERSE && t.method === "disperseToken" && t.status === "ok") found.push(t.hash);
    }
    const last = items.at(-1);
    if (!res.next_page_params || !last || last.timestamp < PAYOUTS_SINCE) break;
    query = "?" + new URLSearchParams({ filter: "from", ...res.next_page_params }).toString();
  }
  const payouts = [];
  for (const hash of found) {
    const t = await blockscout(`/transactions/${hash}`);
    if (t.timestamp < PAYOUTS_SINCE) continue;
    const p = Object.fromEntries((t.decoded_input?.parameters ?? []).map((x) => [x.name, x.value]));
    if (String(p.token).toLowerCase() !== IMD || !Array.isArray(p.recipients)) continue;
    const byWallet = new Map();
    let total = 0n, perSeat = null;
    p.recipients.forEach((w, i) => {
      const v = BigInt(p.values[i]);
      const k = w.toLowerCase();
      byWallet.set(k, (byWallet.get(k) ?? 0n) + v);
      total += v;
      if (v > 0n && (perSeat === null || v < perSeat)) perSeat = v;
    });
    const seats = (v) => (perSeat ? Number((v + perSeat / 2n) / perSeat) : 0);
    payouts.push({
      tx: t.hash, time: t.timestamp, block: t.block_number, total: total.toString(), perSeat: perSeat?.toString() ?? null,
      seatCount: [...byWallet.values()].reduce((n, v) => n + seats(v), 0),
      paid: Object.fromEntries([...byWallet].map(([w, v]) => [w, v.toString()])),
    });
  }
  return payouts.sort((a, b) => b.block - a.block);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

async function main() {
  const [list, sitesRes, contrib, health] = await Promise.all([
    getJson("/launches"), getJson("/sites"), getJson("/contributors"), getJson("/health").catch(() => null),
  ]);
  const summaries = Array.isArray(list) ? list : list.launches ?? [];
  const sites = sitesRes.sites ?? [];
  // A launch's claim page is published by a separate frontend job, so match by contract:
  // every claim site ships claim-config.json naming its distributor.
  const siteByDistributor = new Map();
  await mapLimit(sites.filter((s) => s.url && s.status === "named" && !s.supersededBy), 6, async (s) => {
    try {
      const r = await fetch(new URL("claim-config.json", s.url + "/"), { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return;
      const c = await r.json();
      if (typeof c.distributor === "string") siteByDistributor.set(c.distributor.toLowerCase(), s.url);
    } catch { /* not a claim site */ }
  });

  const details = await mapLimit(summaries, 6, (l) => getJson(`/launches/${l.id}`).catch(() => null));

  const launches = [];
  for (const d of details) {
    if (!d) continue;
    const token = (d.artifacts ?? []).find((a) => a.role === "token");
    const distributor = (d.artifacts ?? []).find((a) => a.role === "distributor");
    const manifestToken = d.attestation?.manifest?.token ?? {};
    const allocations = (d.allocations ?? []).map((a) => ({ wallet: a.wallet.toLowerCase(), amount: a.amount, bps: a.shareBps, agentId: a.agentId ?? null }));
    // Policy v5 launches carry a reward snapshot: every accepted work item in the window
    // before the launch, and per wallet how much came from work on this launch versus the
    // pool shared with everyone recently active. Aggregate it per allocation; the raw list
    // (tens of thousands of items) stays out of the snapshot.
    const rs = d.rewardSnapshot;
    let reward = null;
    if (rs && Array.isArray(rs.work)) {
      const launchJobs = new Set((d.jobs ?? []).map((j) => j.id));
      // Per wallet: everything accepted in the window, by kind, plus the part we can tie to
      // this launch's own jobs (the API lists only the final stage job, so that part is a floor).
      const per = new Map();
      for (const w of rs.work) {
        const k = w.wallet.toLowerCase();
        const e = per.get(k) ?? { total: {}, launch: {} };
        e.total[w.kind] = (e.total[w.kind] ?? 0) + 1;
        if (launchJobs.has(w.jobId)) e.launch[w.kind] = (e.launch[w.kind] ?? 0) + 1;
        per.set(k, e);
      }
      const split = new Map((rs.breakdown ?? []).map((b) => [b.wallet.toLowerCase(), b]));
      for (const a of allocations) {
        const b = split.get(a.wallet);
        if (b) { a.launchAmount = b.launchAmount; a.recentAmount = b.recentAmount; }
        const e = per.get(a.wallet);
        if (e) a.work = e;
      }
      const totals = {};
      for (const w of rs.work) totals[w.kind] = (totals[w.kind] ?? 0) + 1;
      reward = { from: rs.from, to: rs.to, recentBps: rs.recentContributorBps ?? null, version: rs.version ?? null, workTotals: totals, recentWallets: per.size };
    }
    const failure = d.deployFailure ? String(d.deployFailure).split("\n")[0].slice(0, 140) : null;
    launches.push({
      number: d.launchNumber, id: d.id, kind: d.kind, status: d.status, chainId: d.chainId,
      policy: d.policyVersion ?? null, parkedReason: d.parkedReason ?? null, deployFailure: failure, reward,
      createdAt: d.createdAt, repo: d.sourceRepoUrl ?? null,
      site: distributor ? siteByDistributor.get(distributor.address.toLowerCase()) ?? null : null,
      token: token ? { address: token.address, name: manifestToken.name ?? token.name, symbol: manifestToken.symbol ?? null, decimals: manifestToken.decimals ?? 18 } : null,
      distributor: distributor?.address ?? null,
      allocations,
    });
  }

  // Claim status and round data, straight from each distributor.
  for (const chainId of new Set(launches.map((l) => l.chainId))) {
    const onChain = launches.filter((l) => l.chainId === chainId && l.distributor && RPC[chainId]);
    const calls = [];
    for (const l of onChain) {
      calls.push({ l, k: "round", to: l.distributor, data: SEL.roundOf + word("0") });
      calls.push({ l, k: "openedAt", to: l.distributor, data: SEL.openedAt + word("0") });
      calls.push({ l, k: "sweepDelay", to: l.distributor, data: SEL.sweepDelay });
      for (const a of l.allocations) calls.push({ l, a, k: "claimed", to: l.distributor, data: SEL.claimed + word("0") + addrWord(a.wallet) });
    }
    const res = await ethCalls(chainId, calls);
    calls.forEach((c, i) => {
      const r = res[i];
      if (r === null) return;
      if (c.k === "claimed") c.a.claimed = u256(r) === 1n;
      else if (c.k === "round") { c.l.funded = u256(r, 1).toString(); c.l.claimedTotal = u256(r, 2).toString(); c.l.unlocksAt = Number(u256(r, 3)); }
      else if (c.k === "openedAt") c.l.openedAt = Number(u256(r));
      else if (c.k === "sweepDelay") c.l.sweepDelay = Number(u256(r));
    });
    for (const l of onChain) if (l.openedAt && l.sweepDelay) l.sweepAfter = l.openedAt + l.sweepDelay;
  }

  const [held, earned] = await ethCalls(1, [
    { to: REWARD_DISTRIBUTOR, data: SEL.heldNft }, { to: REWARD_DISTRIBUTOR, data: SEL.nftEarned },
  ]);

  // One row per NFT. The API lists one entry per device key, so an NFT paired to a new
  // machine shows up twice; merge those, keeping the wallet that owns it now (last entry).
  const byToken = new Map();
  for (const c of contrib.contributors ?? []) {
    const id = String(c.tokenId);
    const e = byToken.get(id) ?? { tokenId: id, wallet: "", attempts: 0, accepted: 0, rejected: 0, pending: 0, ms: 0, devices: 0 };
    e.wallet = c.wallet.toLowerCase(); e.attempts += Number(c.attempts); e.accepted += Number(c.accepted);
    e.rejected += Number(c.rejected ?? 0); e.pending += Number(c.pending ?? 0); e.ms += Number(c.wallClockMs); e.devices++;
    byToken.set(id, e);
  }
  const seats = [...byToken.values()].map(({ ms, ...e }) => ({ ...e, hours: Math.round(ms / 36e5 * 10) / 10 })).sort((a, b) => b.accepted - a.accepted);
  seats.forEach((s, i) => { s.rank = i + 1; });

  // Payouts are optional: if Blockscout is down, publish the rest without them.
  const payouts = await readPayouts().catch((e) => { console.warn("payouts skipped:", e.message); return null; });

  launches.sort((a, b) => b.number - a.number);
  const snapshot = {
    v: 2,
    generatedAt: new Date().toISOString(),
    explorers: EXPLORER,
    network: health ? {
      online: health.connectedDaemons, enrolled: health.activeEnrollments, acceptedLastDay: health.acceptedLastDay, build: health.version,
      // paid orders: holders paying the network (x402) to open jobs, launches, oracle requests, workflows
      payments: health.payments?.enabled ? {
        paid: health.payments.orders?.paid ?? null, failed: health.payments.orders?.payment_failed ?? null,
        expired: health.payments.orders?.expired ?? null, lastPaidAt: health.payments.lastPaidAt ?? null,
        actions: health.payments.actions ?? [],
      } : null,
    } : null,
    nodeReserve: held ? { held: u256(held).toString(), earned: earned ? u256(earned).toString() : null, contract: REWARD_DISTRIBUTOR } : null,
    seatCount: seats.length,
    seats,
    launches,
    payouts,
    payoutSender: PAYOUT_SENDER,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot));
  const withAlloc = launches.filter((l) => l.allocations.length).length;
  const withReward = launches.filter((l) => l.reward).length;
  console.log(`wrote ${OUT}: ${launches.length} launches (${withAlloc} with allocations, ${withReward} with reward breakdown), ${seats.length} seats, ${payouts ? payouts.length + " payouts" : "no payouts"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
