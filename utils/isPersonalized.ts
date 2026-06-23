import { StoredHandle } from '@koralabs/kora-labs-common';

/**
 * Whether a handle (or sub-handle) has *been* personalized — the state the API was missing
 * (Discord ticket #1958 / issue #199). This is distinct from `pz_enabled`, which only says
 * personalization is *allowed* (a capability/permission), not that any was applied.
 *
 * True when the rendered image differs from the standard image (a chosen — or creator/partner
 * default-applied — background or pfp changes the image hash) OR when any personalization
 * content is present (designer, portal, socials/URLs). Creator/partner-applied defaults count:
 * they populate these same fields.
 *
 * This is the single source of truth for "is personalized": it backs both the `is_personalized`
 * field on the API view model AND the `PERSONALIZED` secondary index in `handlesRepository`, so
 * the per-handle field and the `?personalized=` filter can never disagree.
 */
export const isHandlePersonalized = (
    handle: Pick<StoredHandle, 'image_hash' | 'standard_image_hash' | 'personalization'>
): boolean => {
    if (handle.image_hash !== handle.standard_image_hash) return true;
    const pz = handle.personalization;
    return !!pz?.designer || !!pz?.portal || !!pz?.socials;
};
