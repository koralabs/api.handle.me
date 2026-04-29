import { ScriptType } from '@koralabs/kora-labs-common';

export const DEFAULT_SCRIPT_ARTIFACT_NETWORK = 'preview';
export const SCRIPT_ARTIFACT_NETWORKS = ['preview', 'preprod', 'mainnet'] as const;

export type ScriptArtifactNetwork = (typeof SCRIPT_ARTIFACT_NETWORKS)[number];
export type ScriptSource = { slug: string; repo: string; deploymentStatePath?: string };

export const SCRIPT_SOURCES: Record<ScriptType, ScriptSource> = {
    [ScriptType.PZ_CONTRACT]: { slug: 'pers', repo: 'handles-personalization', deploymentStatePath: 'deploy/${network}/personalization.yaml' },
    [ScriptType.SUB_HANDLE_SETTINGS]: { slug: 'subh', repo: 'handles-subhandle-settings' },
    [ScriptType.MARKETPLACE_CONTRACT]: { slug: 'mkpl', repo: 'handles-marketplace-contracts' },
    [ScriptType.DEMI_MINT_PROXY]: { slug: 'demimntprx', repo: 'decentralized-minting' },
    [ScriptType.DEMI_MINT]: { slug: 'demimnt', repo: 'decentralized-minting' },
    [ScriptType.DEMI_MINTING_DATA]: { slug: 'demimntmpt', repo: 'decentralized-minting' },
    [ScriptType.DEMI_ORDERS]: { slug: 'demiord', repo: 'decentralized-minting' },
    [ScriptType.HAL_MINT_PROXY]: { slug: 'halmntprx', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_MINT]: { slug: 'halmnt', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_MINTING_DATA]: { slug: 'halmntmpt', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_ORDERS_SPEND]: { slug: 'halord', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_REF_SPEND_PROXY]: { slug: 'halrefprx', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_REF_SPEND]: { slug: 'halref', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_ROYALTY_SPEND]: { slug: 'halroy', repo: 'hal-minting-contracts' }
};

export const SCRIPT_TYPES_BY_SLUG = Object.entries(SCRIPT_SOURCES)
    .sort(([, left], [, right]) => right.slug.length - left.slug.length)
    .map(([type, source]) => [source.slug, type as ScriptType] as const);

export const LEGACY_SCRIPT_TYPE_ALIASES: Record<string, ScriptType> = {
    pz_contract: ScriptType.PZ_CONTRACT,
    sub_handle_settings: ScriptType.SUB_HANDLE_SETTINGS,
    marketplace_contract: ScriptType.MARKETPLACE_CONTRACT,
    demi_mint_proxy: ScriptType.DEMI_MINT_PROXY,
    demi_mint: ScriptType.DEMI_MINT,
    demi_minting_data: ScriptType.DEMI_MINTING_DATA,
    demi_orders: ScriptType.DEMI_ORDERS,
    hal_mint_proxy: ScriptType.HAL_MINT_PROXY,
    hal_mint: ScriptType.HAL_MINT,
    hal_minting_data: ScriptType.HAL_MINTING_DATA,
    hal_orders_spend: ScriptType.HAL_ORDERS_SPEND,
    hal_ref_spend_proxy: ScriptType.HAL_REF_SPEND_PROXY,
    hal_ref_spend: ScriptType.HAL_REF_SPEND,
    hal_royalty_spend: ScriptType.HAL_ROYALTY_SPEND
};

export const SCRIPT_TYPE_BY_QUERY = Object.fromEntries(
    Object.entries(SCRIPT_SOURCES).flatMap(([type, source]) => [[source.slug, type as ScriptType]])
) as Record<string, ScriptType>;

export const resolveScriptArtifactNetwork = (network = process.env.NETWORK): ScriptArtifactNetwork => {
    const normalized = `${network ?? ''}`.toLowerCase();
    return SCRIPT_ARTIFACT_NETWORKS.find((candidate) => candidate === normalized) ?? DEFAULT_SCRIPT_ARTIFACT_NETWORK;
};
