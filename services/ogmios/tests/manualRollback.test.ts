import { Logger } from '@koralabs/kora-labs-common';
import { manualRollback } from '../utils/manualRollback';

describe('manualRollback', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('emits the default RollBackward request after the default timeout', () => {
        const processMessage = jest.fn().mockResolvedValue(undefined);
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        manualRollback(processMessage);

        jest.advanceTimersByTime(34999);
        expect(processMessage).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);

        expect(loggerSpy).toHaveBeenCalledWith('PERFORMING ROLLBACK!!!');
        expect(processMessage).toHaveBeenCalledTimes(1);

        const payload = JSON.parse(processMessage.mock.calls[0][0] as string);
        expect(payload).toEqual(expect.objectContaining({
            type: 'jsonwsp/response',
            version: '1.0',
            servicename: 'ogmios',
            methodname: 'RequestNext',
            reflection: null
        }));
        expect(payload.result.RollBackward.point).toEqual({
            slot: 13631415,
            hash: 'a0177bc9ad5cc0a04ea5ccd3b5e3817ef33d885156434e4f0de34847dcfc114a'
        });
        expect(payload.result.RollBackward.tip).toEqual({
            slot: 17288960,
            hash: 'f69cbe83f0129c7691b61e96ddb16805751f54aa3e2ea7e1e17cb2fb837e4d81',
            blockNo: 487552
        });
    });

    it('uses caller provided timeout and rollback point', () => {
        const processMessage = jest.fn().mockResolvedValue(undefined);
        jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        manualRollback(processMessage, 25, 42, 'custom-rollback-hash');

        jest.advanceTimersByTime(24);
        expect(processMessage).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);

        const payload = JSON.parse(processMessage.mock.calls[0][0] as string);
        expect(payload.result.RollBackward.point).toEqual({
            slot: 42,
            hash: 'custom-rollback-hash'
        });
    });
});
