import { isHandlePersonalized } from './isPersonalized';

const base = {
    image_hash: '0xabc',
    standard_image_hash: '0xabc',
    personalization: undefined
} as any;

describe('isHandlePersonalized', () => {
    it('is false when the image is unchanged and there is no personalization content', () => {
        expect(isHandlePersonalized(base)).toBe(false);
        // bookkeeping-only personalization (no designer/portal/socials) does not count
        expect(
            isHandlePersonalized({ ...base, personalization: { validated_by: '', trial: false, nsfw: false } as any })
        ).toBe(false);
    });

    it('is true when the rendered image differs from the standard image (bg/pfp applied — incl. creator/partner defaults)', () => {
        expect(isHandlePersonalized({ ...base, image_hash: '0xdef', standard_image_hash: '0xabc' })).toBe(true);
    });

    it('is true on socials/URLs (the #1958 case), portal, or designer even when the image is unchanged', () => {
        expect(isHandlePersonalized({ ...base, personalization: { socials: [{ url: 'x', display: 'x' }] } as any })).toBe(true);
        expect(isHandlePersonalized({ ...base, personalization: { portal: {} } as any })).toBe(true);
        expect(isHandlePersonalized({ ...base, personalization: { designer: {} } as any })).toBe(true);
    });
});
