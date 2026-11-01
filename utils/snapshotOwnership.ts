// The scanner registers only a lease it successfully acquired. Merely observing
// another invocation's token in Valkey does not authorize a snapshot import.
let scannerOwner: string | undefined;
export const registerSnapshotScannerOwner = (owner: string) => { scannerOwner = owner; };
export const unregisterSnapshotScannerOwner = (owner: string) => { if (scannerOwner === owner) scannerOwner = undefined; };
export const getSnapshotScannerOwner = () => scannerOwner;
