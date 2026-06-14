import https from 'https';

const MAX_IPFS_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_CBOR_COLLECTION_ITEMS = 100000n;

const readCborArgument = (buffer: Buffer, offset: number, additionalInfo: number): { value?: bigint; offset: number; indefinite?: boolean; error?: string } => {
    if (additionalInfo < 24) {
        return { value: BigInt(additionalInfo), offset };
    }

    if (additionalInfo === 24) {
        if (offset + 1 > buffer.length) {
            return { offset, error: 'truncated one-byte length' };
        }
        return { value: BigInt(buffer.readUInt8(offset)), offset: offset + 1 };
    }

    if (additionalInfo === 25) {
        if (offset + 2 > buffer.length) {
            return { offset, error: 'truncated two-byte length' };
        }
        return { value: BigInt(buffer.readUInt16BE(offset)), offset: offset + 2 };
    }

    if (additionalInfo === 26) {
        if (offset + 4 > buffer.length) {
            return { offset, error: 'truncated four-byte length' };
        }
        return { value: BigInt(buffer.readUInt32BE(offset)), offset: offset + 4 };
    }

    if (additionalInfo === 27) {
        if (offset + 8 > buffer.length) {
            return { offset, error: 'truncated eight-byte length' };
        }
        return { value: buffer.readBigUInt64BE(offset), offset: offset + 8 };
    }

    if (additionalInfo === 31) {
        return { offset, indefinite: true };
    }

    return { offset, error: `invalid additional info ${additionalInfo}` };
};

const scanCborItem = (buffer: Buffer, offset: number, depth = 0): { offset: number; error?: string } => {
    if (depth > 64) {
        return { offset, error: 'nested too deeply' };
    }

    if (offset >= buffer.length) {
        return { offset, error: 'truncated item' };
    }

    const initialByte = buffer.readUInt8(offset);
    if (initialByte === 0xff) {
        return { offset, error: 'unexpected break byte' };
    }

    const majorType = initialByte >> 5;
    const additionalInfo = initialByte & 0x1f;
    const argument = readCborArgument(buffer, offset + 1, additionalInfo);

    if (argument.error) {
        return { offset: argument.offset, error: argument.error };
    }

    if (majorType === 0 || majorType === 1 || majorType === 7) {
        if (argument.indefinite) {
            return { offset: argument.offset, error: 'invalid indefinite scalar' };
        }
        return { offset: argument.offset };
    }

    if (majorType === 2 || majorType === 3) {
        if (argument.indefinite) {
            let chunkOffset = argument.offset;
            while (chunkOffset < buffer.length && buffer.readUInt8(chunkOffset) !== 0xff) {
                const chunkType = buffer.readUInt8(chunkOffset) >> 5;
                if (chunkType !== majorType) {
                    return { offset: chunkOffset, error: 'invalid indefinite string chunk' };
                }

                const chunk = scanCborItem(buffer, chunkOffset, depth + 1);
                if (chunk.error) {
                    return chunk;
                }
                chunkOffset = chunk.offset;
            }

            if (chunkOffset >= buffer.length) {
                return { offset: chunkOffset, error: 'unterminated indefinite string' };
            }
            return { offset: chunkOffset + 1 };
        }

        const declaredLength = argument.value ?? 0n;
        const remainingLength = BigInt(buffer.length - argument.offset);
        if (declaredLength > remainingLength) {
            return {
                offset: argument.offset,
                error: `declared ${majorType === 2 ? 'byte' : 'text'} string length ${declaredLength.toString()} exceeds remaining payload bytes ${remainingLength.toString()}`
            };
        }

        return { offset: argument.offset + Number(declaredLength) };
    }

    if (majorType === 4 || majorType === 5) {
        const valuesPerEntry = majorType === 5 ? 2n : 1n;
        let itemOffset = argument.offset;

        if (argument.indefinite) {
            while (itemOffset < buffer.length && buffer.readUInt8(itemOffset) !== 0xff) {
                const item = scanCborItem(buffer, itemOffset, depth + 1);
                if (item.error) {
                    return item;
                }
                itemOffset = item.offset;
            }

            if (itemOffset >= buffer.length) {
                return { offset: itemOffset, error: `unterminated indefinite ${majorType === 5 ? 'map' : 'array'}` };
            }
            return { offset: itemOffset + 1 };
        }

        const entryCount = argument.value ?? 0n;
        if (entryCount > MAX_CBOR_COLLECTION_ITEMS) {
            return { offset: argument.offset, error: `declared ${majorType === 5 ? 'map' : 'array'} length ${entryCount.toString()} exceeds item limit ${MAX_CBOR_COLLECTION_ITEMS.toString()}` };
        }

        const itemCount = entryCount * valuesPerEntry;
        for (let index = 0n; index < itemCount; index++) {
            const item = scanCborItem(buffer, itemOffset, depth + 1);
            if (item.error) {
                return item;
            }
            itemOffset = item.offset;
        }

        return { offset: itemOffset };
    }

    if (majorType === 6) {
        if (argument.indefinite) {
            return { offset: argument.offset, error: 'invalid indefinite tag' };
        }
        return scanCborItem(buffer, argument.offset, depth + 1);
    }

    return { offset: argument.offset, error: `unsupported major type ${majorType}` };
};

const validateCborPayload = (buffer: Buffer): string | undefined => {
    if (!buffer.length) {
        return 'empty CBOR payload';
    }

    let offset = 0;
    while (offset < buffer.length) {
        const item = scanCborItem(buffer, offset);
        if (item.error) {
            return `Invalid IPFS CBOR payload: ${item.error}`;
        }
        offset = item.offset;
    }

    return undefined;
};

export const requestIpfs = (
    url: string
): Promise<{
    statusCode?: number;
    cbor?: string;
    error?: string
}> => {
    return new Promise((resolve) => {
        let resolved = false;

        const finish = (result: { statusCode?: number; cbor?: string; error?: string }) => {
            if (!resolved) {
                resolved = true;
                resolve(result);
            }
        };

        try {
            const options: https.RequestOptions = {
                method: 'GET',
                headers: {
                    Accept: 'application/octet-stream'
                }
            };

            const body: Buffer[] = [];
            let bodyLength = 0;
            const post_req = https.request(url, options, (res) => {
                res.on('data', (chunk) => {
                    if (resolved) {
                        return;
                    }

                    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bodyLength += bufferChunk.length;

                    if (bodyLength > MAX_IPFS_RESPONSE_BYTES) {
                        finish({
                            statusCode: 413,
                            error: `IPFS response exceeded ${MAX_IPFS_RESPONSE_BYTES} byte limit`
                        });
                        res.destroy?.();
                        post_req.destroy?.();
                        return;
                    }

                    body.push(bufferChunk);
                });
                res.on('error', (err) => {
                    finish({
                        statusCode: 500,
                        error: err.message
                    });
                });
                res.on('end', () => {
                    if (resolved) {
                        return;
                    }

                    const responseBody = Buffer.concat(body, bodyLength);
                    if (res.statusCode === 200) {
                        const validationError = validateCborPayload(responseBody);
                        if (validationError) {
                            finish({
                                statusCode: 422,
                                error: validationError
                            });
                            return;
                        }
                    }

                    finish({
                        statusCode: res.statusCode,
                        cbor: responseBody.toString('hex')
                    });
                });
            }).on('error', (err) => {
                finish({
                    statusCode: 500,
                    error: err.message
                });
            });
            post_req.end();
        }
        catch (error: any) {
            finish({
                statusCode: 500,
                error: error.message
            });
        }
    });
};
