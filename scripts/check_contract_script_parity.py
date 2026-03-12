#!/usr/bin/env python3
import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = ROOT.parent
OUT_ROOT = ROOT / "tmp" / "contract-script-parity"
UA_DEFAULT = "kora-backend-request/1.0"

NETWORKS = {
    "preview": "https://preview.api.handle.me",
    "preprod": "https://preprod.api.handle.me",
    "mainnet": "https://api.handle.me",
}

DEFAULT_FAMILIES = [
    {"label": "mkpl", "source_handle": "dev@golddy", "latest_handle": "mkpl1@handlecontract", "type": "MARKETPLACE"},
    {"label": "subh", "source_handle": "subhsetcont_003", "latest_handle": "subh1@handlecontract", "type": "SUBH"},
    {"label": "demimntprx", "source_handle": "mint_proxy@demi_scripts", "latest_handle": "demimntprx1@handlecontract", "type": "DEMI_MINT_PROXY"},
    {"label": "demimntmpt", "source_handle": "mint_data_v1@demi_scripts", "latest_handle": "demimntmpt1@handlecontract", "type": "DEMI_MINT_DATA"},
    {"label": "demimnt", "source_handle": "mint_v1@demi_scripts", "latest_handle": "demimnt1@handlecontract", "type": "DEMI_MINT"},
    {"label": "demiord", "source_handle": "orders@demi_scripts", "latest_handle": "demiord1@handlecontract", "type": "DEMI_ORDER"},
    {"label": "halmntprx", "source_handle": "hal_mnt_prxy@handle_contract", "latest_handle": "halmntprx1@handlecontract", "type": "HAL_MINT_PROXY"},
    {"label": "halmntmpt", "source_handle": "hal_mnt_data@handle_contract", "latest_handle": "halmntmpt1@handlecontract", "type": "HAL_MINT_DATA"},
    {"label": "halmnt", "source_handle": "hal_mnt@handle_contract", "latest_handle": "halmnt1@handlecontract", "type": "HAL_MINT"},
    {"label": "halord", "source_handle": "hal_ord_spnd@handle_contract", "latest_handle": "halord1@handlecontract", "type": "HAL_ORDER"},
    {"label": "halrefprx", "source_handle": "hal_rf_sd_px@handle_contract", "latest_handle": "halrefprx1@handlecontract", "type": "HAL_REF_PROXY"},
    {"label": "halref", "source_handle": "hal_ref_spnd@handle_contract", "latest_handle": "halref1@handlecontract", "type": "HAL_REF"},
    {"label": "halroy", "source_handle": "hal_roy_spnd@handle_contract", "latest_handle": "halroy1@handlecontract", "type": "HAL_ROY"},
    {"label": "pers", "source_handle": "pz_contract_06", "latest_handle": "pers6@handlecontract", "type": "PZ_CONTRACT"},
]

def load_user_agent():
    for env_path in (
        ROOT / ".env.local",
        ROOT / ".env",
        WORKSPACE_ROOT / "kora-bot" / ".env.local",
        WORKSPACE_ROOT / "kora-bot" / ".env",
    ):
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            if line.startswith("KORA_USER_AGENT="):
                return line.split("=", 1)[1].strip().strip("'").strip('"')
    return UA_DEFAULT


UA = load_user_agent()


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))


def http_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as res:
        return res.read().decode("utf-8").strip()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("network", nargs="?", default="preview", choices=sorted(NETWORKS))
    parser.add_argument("--pairs-json", dest="pairs_json")
    return parser.parse_args()


def load_pairs(pairs_json):
    if not pairs_json:
        return DEFAULT_FAMILIES
    return json.loads(Path(pairs_json).read_text())


def main():
    args = parse_args()
    base = NETWORKS[args.network]
    families = load_pairs(args.pairs_json)
    rows = []
    for family in families:
        source_handle = family["source_handle"]
        latest_handle = family["latest_handle"]
        source_script = http_json(f"{base}/handles/{urllib.parse.quote(source_handle)}/script")
        latest_script = http_json(f"{base}/handles/{urllib.parse.quote(latest_handle)}/script")
        match = (source_script.get("cbor") or source_script.get("cborHex")) == (latest_script.get("cbor") or latest_script.get("cborHex"))
        rows.append({
            "label": family["label"],
            "type": family.get("type"),
            "source_handle": source_handle,
            "latest_handle_expected": latest_handle,
            "source_validator_hash": source_script.get("validatorHash"),
            "latest_validator_hash": latest_script.get("validatorHash"),
            "match": match,
        })

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    suffix = Path(args.pairs_json).stem if args.pairs_json else args.network
    json_path = OUT_ROOT / f"{suffix}.json"
    md_path = OUT_ROOT / f"{suffix}.md"
    json_path.write_text(json.dumps(rows, indent=2))
    lines = [f"# {args.network} Contract Script Parity", ""]
    for row in rows:
        status = "MATCH" if row["match"] else "MISMATCH"
        lines.append(f"- `{row['label']}` `{status}`")
        lines.append(f"  expected latest handle: `{row['latest_handle_expected']}`")
        lines.append(f"  source hash: `{row['source_validator_hash']}`")
        lines.append(f"  latest hash: `{row['latest_validator_hash']}`")
    md_path.write_text("\n".join(lines) + "\n")
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
