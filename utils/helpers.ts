import { delay, Logger } from "@koralabs/kora-labs-common";

export const defaultKoiosSettings = {_inputs: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false, _governance: false, _metadata: true, _assets: true}

export const blockfrostApiCall = async (endpointSegment: string) => {
    const headers = {
        project_id: process.env.BLOCKFROST_API_KEY ?? '',
        'Content-Type': 'application/json'
    };

    const url = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/${endpointSegment}`;
    return await fetch(url, {headers})
};

export const fetchPaginatedResults = async <T>(endpointSegment: string): Promise<T[]> => {
    const maxCount = 100;
    let page = 1;
    let hasMorePages = true;

    let results: T[] = [];
    try {
        while (hasMorePages) {
            const response = await blockfrostApiCall(`${endpointSegment}?order=asc&count=${maxCount}&page=${page}`);

            if (response.status == 404) {
                return [];
            }
            if (response.status >= 300) {
                hasMorePages = false;
            } else {
                const items = await response.json();
                results = results.concat(items);
                hasMorePages = items.length == maxCount;
            }
            page += 1;
            await delay(100);
        }
    } catch (error) {
        Logger.log({ message: `Error fetching ${endpointSegment}: ${error}`, category: LogCategory.NOTIFY, event: 'fetchPaginatedResults' });
        return [];
    }

    return results;
};

const fetchKoios = async(path: string, method = 'GET', body?: string) => {
    const url = `https://${NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase()}.koios.rest/api/v1/${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.KOIOS_API_BEARER_TOKEN}`
        },
        body
    }).then((res) => res.json());

    return res;
}