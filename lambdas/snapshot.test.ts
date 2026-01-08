import { BlockPraos } from "@cardano-ogmios/schema";
import { HandlesRepository } from "../repositories/handlesRepository";
import { processBlock } from "../services/processBlock";
import { RedisHandlesStore } from "../stores/redis";

const lambda = require("./snapshot");

const storeInstance = new RedisHandlesStore();
const repo = new HandlesRepository(storeInstance);
repo.initialize();
repo.rollBackToGenesis();

const block = {
    "id": "0000000000000000000000000000000000000000000000000000000000000000",
    "slot": 123456789,
    "transactions": [
        {
            "mint": {
                "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a": {
                    "000643b070617061676f6f7365": 1,
                    "000de14070617061676f6f7365": 1,
                    "62696769726973686c696f6e": 1,
                    "70617061676f6f7365": -1
                }
            },
            "id": "fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353",
            "spends": "inputs",
            "inputs": [],
            "outputs": [
                {
                    "address": "addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7",
                    "value": {
                        "ada": {
                            "lovelace": 1176630
                        },
                        "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a": {
                            "000de14070617061676f6f7365": 1
                        }
                    }
                },
                {
                    "address": "addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7",
                    "value": {
                        "ada": {
                            "lovelace": 2698523204
                        }
                    }
                },
                {
                    "address": "addr1w9kqg07fu06dlw47q8s8548ulz4ra23caqnh0vg0j3sct8qrsqrpc",
                    "value": {
                        "ada": {
                            "lovelace": 3672120
                        },
                        "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a": {
                            "000643b070617061676f6f7365": 1
                        }
                    },
                    "datum": "d8799faa446e616d654a2470617061676f6f736545696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e677468094a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404776657273696f6e0101af4e7374616e646172645f696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233537374616e646172645f696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd65364a696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd653646706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f616464726573735839011ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679c251da0507cacfe8146dcb7e528c695a35824bc1d005880b234a507f4c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14b7376675f76657273696f6e46312e31352e304c6167726565645f7465726d7340546d6967726174655f7369675f72657175697265640045747269616c00446e73667700ff"
                },
                {
                    "address": "addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7",
                    "value": {
                        "ada": {
                            "lovelace": 1176630
                        },
                        "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a": {
                            "62696769726973686c696f6e": 1
                        }
                    }
                },
            ],
            "signatories": [],
            "metadata": {
                "hash": "",
                "labels": {
                    "721": {
                        "json": {
                            "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a": {
                                "000de14070617061676f6f7365": {
                                    "og": 0,
                                    "name": "$papagoose",
                                    "image": "ipfs://zb2rhn73PodzBd6ahhusERJ3e42ZNx6e9VrD6KgzfmbPFfyB3",
                                    "length": 9,
                                    "rarity": "basic",
                                    "version": 1,
                                    "mediaType": "image/jpeg",
                                    "og_number": 0,
                                    "characters": "letters",
                                    "numeric_modifiers": ""
                                },
                                "bigirishlion": {
                                    "og": 0,
                                    "name": "$bigirishlion",
                                    "image": "ipfs://zb2rhn73PodzBd6ahhusERJ3e42ZNx6e9VrD6KgzfmbPFfyB3",
                                    "length": 9,
                                    "rarity": "basic",
                                    "version": 1,
                                    "mediaType": "image/jpeg",
                                    "og_number": 0,
                                    "characters": "letters",
                                    "numeric_modifiers": ""
                                }
                            }
                        }
                    }
                }
            }
        }
    ]
}

jest.mock("@aws-sdk/client-s3", () => {
  const mockedS3Instance = {
    send: jest.fn(() => {
      return Promise.resolve("success");
    }),
  };
  return {
    S3Client: jest.fn(() => mockedS3Instance),
    PutObjectCommand: jest.fn((params) => params),
  };
});

let mockedS3Instance: any;

describe("lambda tests", () => {
  beforeAll(async () => {
    const AWS = require("@aws-sdk/client-s3");
    mockedS3Instance = new AWS.S3Client();

    // we need to process block first then we can run the snapthot
    await processBlock(block as unknown as BlockPraos, repo);

    repo.setMetrics({ currentSlot: block.slot + 100, currentBlockHash: block.id, utxoSchemaVersion: 7})
  });

  it("should process and create zip file", async () => {
    const sendSpy = jest.spyOn(mockedS3Instance, "send");
    const result = await lambda.handler();
    expect(result).toEqual({ body: "", statusCode: 200 });
    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      Body: expect.any(Object),
      Bucket: "api.handle.me",
      Key: "mainnet/utxo-snapshot/7/handles_utxos.gz",
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      Body: expect.any(Object),
      Bucket: "api.handle.me",
      Key: "preview/utxo-snapshot/7/handles_utxos.gz",
    });
    expect(sendSpy).toHaveBeenNthCalledWith(3, {
      Body: expect.any(Object),
      Bucket: "api.handle.me",
      Key: "preprod/utxo-snapshot/7/handles_utxos.gz",
    });
  });
});
