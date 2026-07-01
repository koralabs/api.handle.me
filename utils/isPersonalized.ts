import { StoredHandle } from '@koralabs/kora-labs-common';

/**
 * Whether a handle (or sub-handle) has *been* personalized — the state the API was missing
 * (Discord ticket #1958 / issue #199). This is distinct from `pz_enabled`, which only says
 * personalization is *allowed* (a capability/permission), not that any was applied.
 *
 * Covers every type of applied personalization, verified against real on-chain datums + IPFS
 * payloads:
 *  - a chosen background or profile picture — the rendered image diverges from the standard
 *    image (`image_hash !== standard_image_hash`), and/or `bg_image`/`pfp_image`/`bg_asset`/
 *    `pfp_asset` are set;
 *  - IPFS-resolved content: `designer`, `portal`, or `socials`/URLs;
 *  - custom resolved chain addresses — any `resolved_addresses` entry beyond the auto-resolved
 *    `ada` (e.g. `btc`, `eth`), which come straight from the holder-set datum.
 *
 * Creator/partner-applied defaults count: they populate these same fields.
 *
 * This is the single source of truth for "is personalized": it backs both the `is_personalized`
 * field on the API view model AND the `PERSONALIZED` secondary index in `handlesRepository`, so
 * the per-handle field and the `?personalized=` filter can never disagree.
 */
export const isHandlePersonalized = (
    handle: Pick<
        StoredHandle,
        | 'image_hash'
        | 'standard_image_hash'
        | 'bg_image'
        | 'pfp_image'
        | 'bg_asset'
        | 'pfp_asset'
        | 'personalization'
        | 'resolved_addresses'
    >
): boolean => {
    // A non-standard rendered image, or an explicitly set background / profile picture.
    if (handle.image_hash !== handle.standard_image_hash) return true;
    if (handle.bg_image || handle.pfp_image || handle.bg_asset || handle.pfp_asset) return true;

    // IPFS-resolved personalization content.
    const pz = handle.personalization;
    if (!!pz?.designer || !!pz?.portal || !!pz?.socials) return true;

    // Custom resolved chain addresses — anything the holder set beyond the auto-resolved `ada`.
    const addresses = handle.resolved_addresses;
    if (addresses && Object.keys(addresses).some((chain) => chain !== 'ada' && !!addresses[chain])) {
        return true;
    }

    return false;
};
