import * as cbor from '@koralabs/kora-labs-common/utils/cbor';
import { decodePoliciesDatum, normalizePolicies } from './policies';

jest.mock('@koralabs/kora-labs-common/utils/cbor', () => ({
    decodeCborToJson: jest.fn()
}));

describe('policies utilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('normalizes tuple policy settings and strips hex prefixes', () => {
        expect(normalizePolicies({
            '0xf0ff': [47931333, 0, -1],
            '0X6C32': ['151974982', '170000000', '180000000']
        })).toEqual({
            f0ff: {
                first_minting_slot: 47931333,
                last_minting_slot: null,
                sunset_slot: null
            },
            '6C32': {
                first_minting_slot: 151974982,
                last_minting_slot: 170000000,
                sunset_slot: 180000000
            }
        });
    });

    it('normalizes object policy settings with snake case and camel case keys', () => {
        expect(normalizePolicies({
            f0ff: {
                first_minting_slot: 10,
                last_minting_slot: 20,
                sunset_slot: 0
            },
            abcd: {
                firstMintingSlot: '30',
                lastMintingSlot: '0',
                sunsetSlot: '40'
            }
        })).toEqual({
            f0ff: {
                first_minting_slot: 10,
                last_minting_slot: 20,
                sunset_slot: null
            },
            abcd: {
                first_minting_slot: 30,
                last_minting_slot: null,
                sunset_slot: 40
            }
        });
    });

    it('accepts array-wrapped datum maps', () => {
        expect(normalizePolicies([{ f0ff: [1, 0, 2] }])).toEqual({
            f0ff: {
                first_minting_slot: 1,
                last_minting_slot: null,
                sunset_slot: 2
            }
        });
    });

    it('rejects malformed policy datum shapes', () => {
        expect(() => normalizePolicies(null)).toThrow('Invalid policies datum format');
        expect(() => normalizePolicies([])).toThrow('Invalid policies datum format');
        expect(() => normalizePolicies({ f0ff: [1, 2] })).toThrow('Invalid policy tuple format');
        expect(() => normalizePolicies({ f0ff: ['not-a-number', 0, 0] })).toThrow('Invalid policy settings format');
        expect(() => normalizePolicies({ f0ff: true })).toThrow('Invalid policy settings format');
    });

    it('decodes policy CBOR as hex-keyed data before normalizing', async () => {
        jest.mocked(cbor.decodeCborToJson).mockResolvedValue({ '0xf0ff': [47931333, 0, 0] } as any);

        await expect(decodePoliciesDatum('d87980')).resolves.toEqual({
            f0ff: {
                first_minting_slot: 47931333,
                last_minting_slot: null,
                sunset_slot: null
            }
        });
        expect(cbor.decodeCborToJson).toHaveBeenCalledWith({
            cborString: 'd87980',
            schema: {},
            defaultKeyType: 'hex'
        });
    });
});
