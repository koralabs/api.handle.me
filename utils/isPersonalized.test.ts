import { isHandlePersonalized } from './isPersonalized';

// A pristine, never-personalized handle: image == standard, no content, only the auto ada address.
const base = {
    image_hash: '0xabc',
    standard_image_hash: '0xabc',
    personalization: undefined,
    resolved_addresses: { ada: 'addr1...' }
} as any;

describe('isHandlePersonalized', () => {
    it('is false for a pristine handle (image unchanged, no content, only auto-resolved ada)', () => {
        expect(isHandlePersonalized(base)).toBe(false);
        // bookkeeping-only personalization (no designer/portal/socials) does not count
        expect(
            isHandlePersonalized({ ...base, personalization: { validated_by: '', trial: false, nsfw: false } as any })
        ).toBe(false);
    });

    it('is true when the rendered image differs from the standard image (bg/pfp applied — incl. creator/partner defaults)', () => {
        expect(isHandlePersonalized({ ...base, image_hash: '0xdef', standard_image_hash: '0xabc' })).toBe(true);
    });

    it('is true on an explicitly set background or profile picture (image/asset), even if the hash matches', () => {
        expect(isHandlePersonalized({ ...base, bg_image: 'ipfs://bg' })).toBe(true);
        expect(isHandlePersonalized({ ...base, pfp_image: 'ipfs://pfp' })).toBe(true);
        expect(isHandlePersonalized({ ...base, bg_asset: '0xbg' })).toBe(true);
        expect(isHandlePersonalized({ ...base, pfp_asset: '0xpfp' })).toBe(true);
    });

    it('is true on socials/URLs (the #1958 case), portal, or designer even when the image is unchanged', () => {
        expect(isHandlePersonalized({ ...base, personalization: { socials: [{ url: 'x', display: 'x' }] } as any })).toBe(true);
        expect(isHandlePersonalized({ ...base, personalization: { portal: {} } as any })).toBe(true);
        expect(isHandlePersonalized({ ...base, personalization: { designer: {} } as any })).toBe(true);
    });

    it('is true on custom resolved chain addresses (anything beyond the auto-resolved ada)', () => {
        expect(isHandlePersonalized({ ...base, resolved_addresses: { ada: 'addr1...', btc: 'bc1...' } })).toBe(true);
        expect(isHandlePersonalized({ ...base, resolved_addresses: { ada: 'addr1...', eth: '0xabc' } })).toBe(true);
        // ada-only (and empty custom values) are not personalization
        expect(isHandlePersonalized({ ...base, resolved_addresses: { ada: 'addr1...', btc: '' } })).toBe(false);
    });
});
