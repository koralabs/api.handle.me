import HomeController from './home.controller';

describe('HomeController tests', () => {
    it('should redirect to /swagger', async () => {
        const controller = new HomeController();
        const redirect = jest.fn();
        const next = jest.fn();

        await controller.index({} as any, { redirect } as any, next);

        expect(redirect).toHaveBeenCalledWith('/swagger');
        expect(next).not.toHaveBeenCalled();
    });

    it('should call next when redirect throws', async () => {
        const controller = new HomeController();
        const next = jest.fn();
        const error = new Error('redirect failed');
        const redirect = jest.fn().mockImplementation(() => {
            throw error;
        });

        await controller.index({} as any, { redirect } as any, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});
