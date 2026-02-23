import { Logger } from '@koralabs/kora-labs-common';
import { debugLog, nullishOr, numericString, writeConsoleLine } from './util';

describe('Utils tests', () => {

    describe('writeConsoleLine', () => {
        const originalClearLine = process.stdout.clearLine;
        const originalCursorTo = process.stdout.cursorTo;

        afterEach(() => {
            process.stdout.clearLine = originalClearLine;
            process.stdout.cursorTo = originalCursorTo;
            jest.restoreAllMocks();
        });

        it('should get correct elapsed time and write to stdout', () => {
            process.stdout.clearLine = jest.fn() as any;
            process.stdout.cursorTo = jest.fn() as any;
            const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(jest.fn(() => true));
            const now = Date.now();
            const message = writeConsoleLine(now, 'starting now');
            expect(message).toEqual('0:00 elapsed. starting now');
            expect(process.stdout.clearLine).toHaveBeenCalledWith(0);
            expect(process.stdout.cursorTo).toHaveBeenCalledWith(0);
            expect(writeSpy).toHaveBeenCalledWith('0:00 elapsed. starting now');
        });

        it('should fallback to logger when tty methods are not available', () => {
            (process.stdout as any).clearLine = undefined;
            (process.stdout as any).cursorTo = undefined;
            const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

            const message = writeConsoleLine(Date.now(), 'fallback');

            expect(message).toEqual('0:00 elapsed. fallback');
            expect(loggerSpy).toHaveBeenCalledWith('0:00 elapsed. fallback');
        });

        it('should use default empty message suffix when msg arg is omitted', () => {
            process.stdout.clearLine = jest.fn() as any;
            process.stdout.cursorTo = jest.fn() as any;
            const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(jest.fn(() => true));

            const message = writeConsoleLine(Date.now());

            expect(message).toEqual('0:00 elapsed. ');
            expect(writeSpy).toHaveBeenCalledWith('0:00 elapsed. ');
        });
    });

    describe('custom matcher helpers', () => {
        it('numericString should match numeric string equivalents', () => {
            expect(numericString(1).asymmetricMatch('1')).toBe(true);
            expect(numericString(1.5).asymmetricMatch('1.5')).toBe(true);
            expect(numericString(1).asymmetricMatch('nope')).toBe(false);
            expect(numericString(0).asymmetricMatch(0)).toBe(true);
        });

        it('nullishOr should match nullish and target values', () => {
            expect(nullishOr('ok').asymmetricMatch(null)).toBe(true);
            expect(nullishOr('ok').asymmetricMatch(undefined)).toBe(true);
            expect(nullishOr('ok').asymmetricMatch('')).toBe(true);
            expect(nullishOr('ok').asymmetricMatch('ok')).toBe(true);
            expect(nullishOr('ok').asymmetricMatch('not-ok')).toBe(false);
        });
    });

    describe('debugLog', () => {
        it('should log normalized handle debug output', () => {
            const logSpy = jest.spyOn(console, 'log').mockImplementation(jest.fn());
            debugLog('test message', 42, {
                hex: 'beef',
                amount: 1,
                updated_slot_number: 100,
                resolved_addresses: { ada: 'addr_test1xyz' },
                utxo: 'abc#0'
            } as any);

            expect(logSpy).toHaveBeenNthCalledWith(1, '**************************************************************');
            expect(logSpy).toHaveBeenNthCalledWith(2, 'test message');
            expect(logSpy).toHaveBeenNthCalledWith(
                3,
                expect.objectContaining({
                    blockSlot: 42,
                    hex: 'beef',
                    amount: 1,
                    handleSlot: 100,
                    address: 'addr_test1xyz',
                    utxo: 'abc#0'
                })
            );
            expect(logSpy).toHaveBeenNthCalledWith(4, '______________________________________________________________');
        });
    });
});
