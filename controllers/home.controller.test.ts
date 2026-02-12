import HomeController from './home.controller';

describe('HomeController tests', () => {
    it('should call sendStatus(200)', async () => {
        const controller = new HomeController();
        const sendStatus = jest.fn();
        const next = jest.fn();

        await controller.index({} as any, { sendStatus } as any, next);

        expect(sendStatus).toHaveBeenCalledWith(200);
        expect(next).not.toHaveBeenCalled();
    });

    it('should call next when sendStatus throws', async () => {
        const controller = new HomeController();
        const next = jest.fn();
        const error = new Error('send failed');
        const sendStatus = jest.fn().mockImplementation(() => {
            throw error;
        });

        await controller.index({} as any, { sendStatus } as any, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});
