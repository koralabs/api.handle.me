// Invariant: the snapshot and scanner entrypoints refuse to run any work when plaintext startup validation fails.
// Failure caught: an entrypoint that skips (or doesn't await) validatePlaintextStartup would run with leftover ciphertext settings.
const mockValidate = jest.fn();
const mockSnapshotHandler = jest.fn();
const mockRunSnapshot = jest.fn();
const mockScan = jest.fn();
const mockScannerHandler = jest.fn();

jest.mock('../utils/startupEnvironment', () => ({ validatePlaintextStartup: (...a: unknown[]) => mockValidate(...a) }));
jest.mock('./snapshot.app', () => ({
    handler: (...a: unknown[]) => mockSnapshotHandler(...a),
    processSnapshot: (...a: unknown[]) => mockRunSnapshot(...a)
}));
jest.mock('./scanner.app', () => ({
    lambdaHandler: (...a: unknown[]) => mockScannerHandler(...a),
    Internal: { scan: (...a: unknown[]) => mockScan(...a), checkRollback: jest.fn(), processRollback: jest.fn(), processReindex: jest.fn() }
}));

import * as snapshot from './snapshot';
import * as scanner from './scanner';

describe('entrypoint startup gate', () => {
    beforeEach(() => { jest.clearAllMocks(); delete process.env.KORA_SCANNER_DEFER_IMPORTS; });

    it('runs the snapshot work after a passing validation', async () => {
        mockValidate.mockResolvedValue(undefined);
        mockSnapshotHandler.mockResolvedValue('handled');
        mockRunSnapshot.mockResolvedValue('processed');
        await expect(snapshot.handler({ a: 1 })).resolves.toBe('handled');
        await expect(snapshot.processSnapshot('preview')).resolves.toBe('processed');
        expect(mockSnapshotHandler).toHaveBeenCalledWith({ a: 1 });
        expect(mockRunSnapshot).toHaveBeenCalledWith('preview');
    });

    it('does not run snapshot work when validation fails', async () => {
        mockValidate.mockRejectedValue(new Error('ciphertext setting found'));
        await expect(snapshot.handler({})).rejects.toThrow('ciphertext setting found');
        await expect(snapshot.processSnapshot('preview')).rejects.toThrow('ciphertext setting found');
        expect(mockSnapshotHandler).not.toHaveBeenCalled();
        expect(mockRunSnapshot).not.toHaveBeenCalled();
    });

    it('runs scanner scan and lambda handler after a passing validation', async () => {
        mockValidate.mockResolvedValue(undefined);
        mockScan.mockResolvedValue('scanned');
        mockScannerHandler.mockResolvedValue('ok');
        await expect((scanner.Internal.scan as any)('x')).resolves.toBe('scanned');
        await expect(scanner.lambdaHandler({}, {})).resolves.toBe('ok');
        expect(mockScan).toHaveBeenCalledWith('x');
    });

    it('does not run scanner work when validation fails', async () => {
        mockValidate.mockRejectedValue(new Error('ciphertext setting found'));
        await expect((scanner.Internal.scan as any)()).rejects.toThrow('ciphertext setting found');
        await expect(scanner.lambdaHandler({}, {})).rejects.toThrow('ciphertext setting found');
        expect(mockScan).not.toHaveBeenCalled();
        expect(mockScannerHandler).not.toHaveBeenCalled();
    });

    it('self-hosted scanner turns a failed startup into a 500 for function-url events only', async () => {
        process.env.KORA_SCANNER_DEFER_IMPORTS = 'true';
        mockValidate.mockRejectedValue(new Error('bad'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const res: any = await scanner.lambdaHandler({ requestContext: { http: {} } }, {});
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body)).toEqual({ message: 'Scanner bootstrap failed' });
        await expect(scanner.lambdaHandler({}, {})).resolves.toBeUndefined();
        expect(mockScannerHandler).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
