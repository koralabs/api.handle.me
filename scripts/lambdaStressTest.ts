
import http, { OutgoingHttpHeaders } from 'http';
import https from 'https';
const NETWORK = 'mainnet';

const apiRequest = async (url: string, accept = 'application/json', method = 'GET', body = '' ): Promise<{ statusCode?: number; body?: string; error?: string, headers?: OutgoingHttpHeaders }> => {
    const client = url.startsWith('http:') ? http : https;
    return new Promise((resolve, reject) => {
        try {
            const options: https.RequestOptions = {
                method: method,
                headers: { Accept: accept, "api-key": "ZUz1N6eiw2W9cOPgEvbm"}
            };

            let resBody = '';
            const get_req = client.request(url, options, (res) => {
                res.on('data', (chunk) => { resBody += chunk; });
                res.on('error', (err) => {
                    resolve({
                        statusCode: res.statusCode,
                        error: err.message
                    });
                });
                res.on('end', (chunk: any) => {
                    resolve({
                        statusCode: res.statusCode,
                        body: resBody,
                        headers: res.headers
                    });
                });
            });

            if (method == 'POST')
                get_req.write(body);

            get_req.end();
        }
        catch (error: any) {
            resolve({
                statusCode: 500,
                error: error.message
            });
        }
    });
};

(async () => {
    for (let i=0; i<100; i++) {
        apiRequest(`https://szhqilxht5vtva67odwuozwuhi0uzwqm.lambda-url.us-west-2.on.aws/handles`).then((res) => {
            console.log(res.statusCode);
            if (res.statusCode != 200)
                console.log(res.body)
        })
    }
})()