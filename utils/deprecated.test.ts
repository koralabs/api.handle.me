import deprecated from './deprecated';

type MockResponse = {
    set: jest.Mock<MockResponse, [string, string]>;
    get: jest.Mock<string | undefined, [string]>;
};

const makeResponse = (initialHeaders: Record<string, string> = {}): MockResponse => {
    const headers = new Map<string, string>(Object.entries(initialHeaders));
    const res = {} as MockResponse;
    res.set = jest.fn((name: string, value: string) => {
        headers.set(name, value);
        return res;
    });
    res.get = jest.fn((name: string) => headers.get(name));
    return res;
};

describe('deprecated middleware', () => {
    it('sets the Deprecation header and continues the middleware chain', () => {
        const req = {} as any;
        const res = makeResponse();
        const next = jest.fn();

        deprecated()(req, res as any, next);

        expect(res.set).toHaveBeenCalledWith('Deprecation', 'true');
        expect(res.set).not.toHaveBeenCalledWith('Link', expect.any(String));
        expect(next).toHaveBeenCalledWith();
    });

    it('adds a successor-version link when a replacement path is supplied', () => {
        const req = { params: { handle: 'alice' } } as any;
        const res = makeResponse();
        const next = jest.fn();

        deprecated((request) => `/handles/${request.params.handle}/utxo`)(req, res as any, next);

        expect(res.set).toHaveBeenCalledWith('Deprecation', 'true');
        expect(res.set).toHaveBeenCalledWith('Link', '</handles/alice/utxo>; rel="successor-version"');
        expect(next).toHaveBeenCalledWith();
    });

    it('appends successor-version links without overwriting existing Link headers', () => {
        const req = { params: { handle: 'alice' } } as any;
        const res = makeResponse({ Link: '<https://api.handle.me/>; rel="describedby"' });
        const next = jest.fn();

        deprecated((request) => `/handles/${request.params.handle}/datum`)(req, res as any, next);

        expect(res.set).toHaveBeenCalledWith(
            'Link',
            '<https://api.handle.me/>; rel="describedby", </handles/alice/datum>; rel="successor-version"'
        );
    });
});
