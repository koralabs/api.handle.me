import https from 'https';

const API_HOST = 'api.handle.me';

const run = async () => {
    https.get({host: API_HOST, path: '/holders', headers: {'api-key': process.env.HANDLES_API_KEY ?? ''}}, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => {
            console.log(JSON.parse(data));
        });
    }).on('error', (e) => {
        console.error(e);
    });
}

(async () => {
    await run();
})()