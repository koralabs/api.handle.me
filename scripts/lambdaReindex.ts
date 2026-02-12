const result = await import('../lambdas/reindex');
export const lambdaHandler = result.lambdaHandler;

await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

// This file is just a wrapper to export the lambda handler without the test mocks. The actual logic and tests are in lambdas/reindex.ts and lambdas/reindex.test.ts respectively. This is necessary because of how Jest hoists mocks and imports, which can interfere with testing the lambda handler directly if it's imported in the same file as the tests. By separating it into this file, we can ensure that the lambda handler is imported without any interference from Jest's mocking system, allowing for proper testing and functionality in both unit tests and end-to-end tests.