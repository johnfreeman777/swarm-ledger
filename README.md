# Swarm Ledger

Who the IMD swarm paid. Live at **https://johnfreeman777.github.io/swarm-ledger/**

Type a wallet address, or an identity.md NFT number, and see:

- every swarm launch that allocated tokens to that wallet, with the amount, share and
  whether it has been claimed;
- the claim page and the distributor contract for each one, so you can check the
  address before signing anything;
- the wallet's seats on the network: accepted and rejected tasks, hours, rank;
- network totals and the POOL4 NFT-node reserve.

The page only reads public data. It never asks you to connect a wallet, and it has
no way to sign or send a transaction.

## How it works

`api.imd.fun` does not allow cross-origin requests from browsers, so the page cannot
read it directly. Instead:

1. **`scripts/snapshot.mjs`** runs every 30 minutes in GitHub Actions. It reads
   `/launches`, `/sites` and `/contributors` from the public API. It then asks each
   launch's MerkleDistributor `claimed(0, wallet)` for every allocation, plus the
   round data, and writes one JSON file.
2. **`index.html`** loads that file. For the wallet you look up, it re-checks every
   claim live against public RPC (publicnode), so a claim you just made shows up
   right away.
3. The workflow publishes both to GitHub Pages. No server, no keys, no dependencies.

Claim pages are published by a separate frontend job, so they are matched to their
launch by the distributor address in each site's `claim-config.json`.

Distributors allow unclaimed tokens to be swept to the treasury after `sweepDelay`
(currently 365 days from opening). Hover the status to see the date.

## Run locally

```sh
node scripts/snapshot.mjs          # writes data/snapshot.json (Node 22+)
python3 -m http.server 8787        # then open http://localhost:8787
```

An unofficial community tool, deliberately styled apart from the official IMD sites so it is never mistaken for one. Not affiliated with the IdentityMD developer.
