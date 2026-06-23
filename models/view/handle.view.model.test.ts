import { HandleType, HttpException, Rarity } from '@koralabs/kora-labs-common';
import { HandleViewModel } from './handle.view.model';

const buildHandle = (overrides: Record<string, any> = {}) =>
    ({
        hex: 'hex',
        name: 'alpha',
        image: 'image',
        standard_image: 'standard',
        holder: 'holder',
        holder_type: 'wallet',
        length: 5,
        og_number: 1,
        rarity: Rarity.common,
        utxo: 'tx#0',
        characters: 'letters',
        numeric_modifiers: '',
        default_in_wallet: 'alpha',
        pfp_asset: '0xpfp',
        bg_asset: '0xbg',
        resolved_addresses: { ada: 'addr' },
        created_slot_number: 1,
        updated_slot_number: 2,
        has_datum: true,
        svg_version: '1',
        image_hash: '0ximg',
        standard_image_hash: '0xstd',
        version: 1,
        handle_type: HandleType.HANDLE,
        policy: '',
        ...overrides
    }) as any;

describe('HandleViewModel', () => {
    it('throws HttpException when handle has no UTxO', () => {
        expect(() => new HandleViewModel(buildHandle({ utxo: '' }))).toThrow(HttpException);
        expect(() => new HandleViewModel(buildHandle({ utxo: '' }))).toThrow('Handle not found');
    });

    it('normalizes hex-prefixed assets and defaults pz_enabled for primary handles', () => {
        const model = new HandleViewModel(buildHandle({ pz_enabled: undefined, handle_type: HandleType.HANDLE }));

        expect(model.pfp_asset).toBe('pfp');
        expect(model.bg_asset).toBe('bg');
        expect(model.image_hash).toBe('img');
        expect(model.standard_image_hash).toBe('std');
        expect(model.pz_enabled).toBe(true);
        expect(model.policy).toBe('');
    });

    it('returns undefined pz_enabled for non-primary handle types when not provided', () => {
        const model = new HandleViewModel(
            buildHandle({
                handle_type: HandleType.VIRTUAL_SUBHANDLE,
                pz_enabled: undefined
            })
        );

        expect(model.pz_enabled).toBeUndefined();
    });

    it('preserves explicit pz_enabled value', () => {
        const model = new HandleViewModel(
            buildHandle({
                handle_type: HandleType.HANDLE,
                pz_enabled: false
            })
        );

        expect(model.pz_enabled).toBe(false);
    });

    it('exposes is_personalized (state) independently of pz_enabled (capability)', () => {
        // pz_enabled defaults true for a root HANDLE, but a handle with no applied
        // personalization (image unchanged, no content) is NOT personalized.
        const notPersonalized = new HandleViewModel(
            buildHandle({ image_hash: '0xsame', standard_image_hash: '0xsame', personalization: undefined })
        );
        expect(notPersonalized.pz_enabled).toBe(true);
        expect(notPersonalized.is_personalized).toBe(false);

        // image differs (bg/pfp applied) → personalized
        expect(
            new HandleViewModel(buildHandle({ image_hash: '0xa', standard_image_hash: '0xb' })).is_personalized
        ).toBe(true);

        // socials/URLs only, image unchanged (the #1958 sub-handle case) → personalized
        expect(
            new HandleViewModel(
                buildHandle({
                    image_hash: '0xsame',
                    standard_image_hash: '0xsame',
                    personalization: { socials: [{ url: 'x', display: 'x' }] }
                })
            ).is_personalized
        ).toBe(true);
    });
});
