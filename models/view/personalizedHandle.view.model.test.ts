import { HttpException } from '@koralabs/kora-labs-common';
import { PersonalizedHandleViewModel } from './personalizedHandle.view.model';

describe('PersonalizedHandleViewModel', () => {
    it('throws when handle or utxo is missing', () => {
        expect(() => new PersonalizedHandleViewModel(null)).toThrow(HttpException);
        expect(() => new PersonalizedHandleViewModel({ utxo: '' } as any)).toThrow('Handle not found');
    });

    it('maps personalization when handle exists', () => {
        const model = new PersonalizedHandleViewModel({
            utxo: 'tx#0',
            personalization: { image: 'ipfs://image' }
        } as any);

        expect(model.personalization).toEqual({ image: 'ipfs://image' });
    });
});
